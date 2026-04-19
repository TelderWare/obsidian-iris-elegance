'use strict';

const { Plugin, PluginSettingTab, Setting, Menu, SuggestModal, MarkdownView, ItemView, Notice, setIcon, getIconIds, getIcon } = require('obsidian');
const { ViewPlugin, Decoration, WidgetType, EditorView, keymap } = require('@codemirror/view');
const { StateField, StateEffect, Prec } = require('@codemirror/state');
const { syntaxTree } = require('@codemirror/language');

/* === bundled from prose.js === */
/* ============================================================
 * Prose Mode
 * Always-hide markdown rendering: marks stay invisible even when
 * the caret is inside them. Cursor steps over hidden ranges via
 * CodeMirror's atomicRanges facet, so the editor handles snapping
 * uniformly for arrow keys, clicks, and selection extension.
 * ============================================================ */

const setProseMode = StateEffect.define();

const proseModeField = StateField.define({
    create: () => false,
    update(value, tr) {
        for (const e of tr.effects) if (e.is(setProseMode)) value = e.value;
        return value;
    },
});

class ProseBulletWidget extends WidgetType {
    constructor(ch) { super(); this.ch = ch; }
    eq(o) { return o.ch === this.ch; }
    toDOM() {
        const el = document.createElement('span');
        el.className = 'elegance-prose-bullet';
        el.textContent = this.ch;
        return el;
    }
}

class ProseCheckboxWidget extends WidgetType {
    constructor(checked, from, to) { super(); this.checked = checked; this.from = from; this.to = to; }
    eq(o) { return o.checked === this.checked && o.from === this.from; }
    toDOM(view) {
        const el = document.createElement('input');
        el.type = 'checkbox';
        el.checked = this.checked;
        el.className = 'elegance-prose-checkbox';
        el.addEventListener('mousedown', e => e.preventDefault());
        el.addEventListener('click', e => {
            e.preventDefault();
            const insert = this.checked ? '[ ]' : '[x]';
            view.dispatch({
                changes: { from: this.from, to: this.to, insert },
                userEvent: 'elegance-prose.toggle-task',
            });
        });
        return el;
    }
    ignoreEvent() { return false; }
}

class ProseEmptyWidget extends WidgetType {
    toDOM() {
        const s = document.createElement('span');
        s.className = 'elegance-prose-empty';
        return s;
    }
    eq() { return true; }
    ignoreEvent() { return true; }
}

class ProseFrontmatterChip extends WidgetType {
    eq() { return true; }
    toDOM() {
        const el = document.createElement('div');
        el.className = 'elegance-prose-frontmatter-chip';
        el.textContent = 'frontmatter';
        return el;
    }
    ignoreEvent() { return true; }
}

class ProseHrWidget extends WidgetType {
    eq() { return true; }
    toDOM() {
        const el = document.createElement('div');
        el.className = 'elegance-prose-hr';
        return el;
    }
    ignoreEvent() { return true; }
}

const PROSE_HIDE_NODES = new Set([
    'HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'URL',
    'StrikethroughMark', 'HighlightMark', 'QuoteMark',
]);

const PROSE_HEADING_CLASS = {
    ATXHeading1: 'elegance-prose-h1',
    ATXHeading2: 'elegance-prose-h2',
    ATXHeading3: 'elegance-prose-h3',
    ATXHeading4: 'elegance-prose-h4',
    ATXHeading5: 'elegance-prose-h5',
    ATXHeading6: 'elegance-prose-h6',
};

const PROSE_WIKILINK_RE = /\[\[([^\[\]\n|]+)(\|([^\[\]\n]+))?\]\]/g;
const PROSE_EMPTY_REPLACE = Decoration.replace({ widget: new ProseEmptyWidget(), inclusive: true });
const PROSE_EMBED_RE = /!\[\[[^\[\]\n]+\]\]/g;
// Inline math: $...$ with non-empty, non-whitespace-only content.
const PROSE_MATH_RE = /\$(?!\s)([^\$\n]*[^\s\$])\$/g;
const PROSE_BULLET_RE = /^(\s*)([-*+])(\s+)/;
const PROSE_NUMBER_RE = /^(\s*)(\d+)([.)])(\s+)/;
const PROSE_TASK_RE = /^(\s*[-*+]\s+)\[([ xX])\]/;
const PROSE_COMPLETE_LINK_RE = /!?\[[^\]\n]*\]\([^)\n]*\)/g;
const PROSE_HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
// Frontmatter: a `---` fence at doc start through the next `---` fence.
const PROSE_FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/;

// Block decorations (frontmatter chip, HR widget, standalone embed line) must
// come from a StateField — CodeMirror forbids ViewPlugins from emitting them.
function buildProseBlockDecorations(state) {
    if (!state.field(proseModeField, false)) return Decoration.none;

    const doc = state.doc;
    const ranges = [];
    const blockReplaced = [];
    const isInBlockReplaced = (a, b) =>
        blockReplaced.some(([s, e]) => a >= s && b <= e);

    // YAML frontmatter
    {
        const head = doc.sliceString(0, Math.min(doc.length, 8000));
        const fm = head.match(PROSE_FRONTMATTER_RE);
        if (fm) {
            const fmEnd = fm[0].length;
            const to = fmEnd > 0 && doc.sliceString(fmEnd - 1, fmEnd) === '\n' ? fmEnd - 1 : fmEnd;
            ranges.push(
                Decoration.replace({ block: true }).range(0, to)
            );
            blockReplaced.push([0, fmEnd]);
        }
    }

    // Horizontal rules — scan whole doc via syntax tree
    syntaxTree(state).iterate({
        from: 0, to: doc.length,
        enter(node) {
            if (isInBlockReplaced(node.from, node.to)) return false;
            if (node.type.name === 'HorizontalRule') {
                const line = doc.lineAt(node.from);
                const lineEnd = line.to + (line.to < doc.length ? 1 : 0);
                ranges.push(
                    Decoration.replace({ widget: new ProseHrWidget(), block: true })
                        .range(line.from, line.to)
                );
                blockReplaced.push([line.from, lineEnd]);
                return false;
            }
            if (node.type.name === 'FencedCode' || node.type.name === 'CodeBlock') return false;
        },
    });

    // Standalone embeds (![[file]] alone on a line) — scan whole doc
    const fullText = doc.sliceString(0, doc.length);
    PROSE_EMBED_RE.lastIndex = 0;
    let em;
    while ((em = PROSE_EMBED_RE.exec(fullText)) !== null) {
        const start = em.index;
        const endE = start + em[0].length;
        if (isInBlockReplaced(start, endE)) continue;
        const line = doc.lineAt(start);
        if (line.text.trim() !== em[0]) continue;
        const lineEnd = line.to + (line.to < doc.length ? 1 : 0);
        ranges.push(Decoration.replace({ block: true }).range(line.from, lineEnd));
        blockReplaced.push([line.from, lineEnd]);
    }

    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    return Decoration.set(ranges, true);
}

const proseBlockField = StateField.define({
    create: state => buildProseBlockDecorations(state),
    update(value, tr) {
        let proseToggled = false;
        for (const e of tr.effects) if (e.is(setProseMode)) { proseToggled = true; break; }
        if (proseToggled || tr.docChanged) return buildProseBlockDecorations(tr.state);
        return value;
    },
    provide: f => EditorView.decorations.from(f),
});

const proseBlockAtomic = EditorView.atomicRanges.of(view =>
    view.state.field(proseBlockField, false) || Decoration.none
);

function buildProseDecorations(view) {
    const ranges = [];
    const atomic = [];
    if (!view.state.field(proseModeField, false)) {
        return { decorations: Decoration.none, atomic: Decoration.none };
    }

    const doc = view.state.doc;
    const seenHeading = new Set();
    const seenQuote = new Set();
    // Block-replaced regions are owned by proseBlockField; read them here so
    // the inline pass can skip nodes that the block layer has already swallowed.
    const blockReplaced = [];
    const blockSet = view.state.field(proseBlockField, false);
    if (blockSet) {
        const cur = blockSet.iter();
        while (cur.value !== null) {
            blockReplaced.push([cur.from, cur.to]);
            cur.next();
        }
    }
    const isInBlockReplaced = (a, b) =>
        blockReplaced.some(([s, e]) => a >= s && b <= e);

    const pushHide = (from, to) => {
        const d = PROSE_EMPTY_REPLACE.range(from, to);
        ranges.push(d);
        atomic.push(d);
    };
    const pushWidget = (deco) => {
        ranges.push(deco);
        atomic.push(deco);
    };

    for (const { from, to } of view.visibleRanges) {
        const text = doc.sliceString(from, to);

        const completeLinkRanges = [];
        PROSE_COMPLETE_LINK_RE.lastIndex = 0;
        let lm;
        while ((lm = PROSE_COMPLETE_LINK_RE.exec(text)) !== null) {
            completeLinkRanges.push([from + lm.index, from + lm.index + lm[0].length]);
        }
        const insideCompleteLink = (a, b) =>
            completeLinkRanges.some(([s, e]) => a >= s && b <= e);

        syntaxTree(view.state).iterate({
            from, to,
            enter(node) {
                const name = node.type.name;
                if (!name) return;
                if (isInBlockReplaced(node.from, node.to)) return false;

                if (PROSE_HEADING_CLASS[name]) {
                    const line = doc.lineAt(node.from);
                    if (!seenHeading.has(line.from)) {
                        seenHeading.add(line.from);
                        ranges.push(Decoration.line({ class: PROSE_HEADING_CLASS[name] }).range(line.from));
                    }
                    return;
                }

                if (name === 'Blockquote') {
                    // Tag every line in the blockquote with a left-border class.
                    // Inner QuoteMarks are still hidden via PROSE_HIDE_NODES below.
                    const startLine = doc.lineAt(node.from).number;
                    const endLine = doc.lineAt(Math.min(node.to, doc.length)).number;
                    for (let n = startLine; n <= endLine; n++) {
                        const line = doc.line(n);
                        if (!seenQuote.has(line.from)) {
                            seenQuote.add(line.from);
                            ranges.push(Decoration.line({ class: 'elegance-prose-quote' }).range(line.from));
                        }
                    }
                    return;
                }

                if (name === 'HorizontalRule') {
                    // Handled by proseBlockField.
                    return false;
                }

                if (name === 'InlineCode') {
                    ranges.push(Decoration.mark({ class: 'elegance-prose-code' }).range(node.from, node.to));
                    return;
                }

                if (name === 'FencedCode' || name === 'CodeBlock') return false;
                if (name === 'Image') return false;

                if (!PROSE_HIDE_NODES.has(name)) return;

                if ((name === 'LinkMark' || name === 'URL') &&
                    !insideCompleteLink(node.from, node.to)) return;

                // Skip empty-wrapper marks like `**`, `~~~~`, `====` where
                // there's no content between the paired marks.
                if (name === 'EmphasisMark' || name === 'StrikethroughMark' ||
                    name === 'HighlightMark' || name === 'CodeMark') {
                    const p = node.node.parent;
                    if (p && (p.to - p.from) <= 2 * (node.to - node.from)) return;
                }

                let end = node.to;
                if (name === 'HeaderMark' && doc.sliceString(end, end + 1) === ' ') end += 1;
                if (name === 'QuoteMark' && doc.sliceString(end, end + 1) === ' ') end += 1;
                pushHide(node.from, end);
            },
        });

        // Per-line markers: bullets, numbered lists, task checkboxes.
        const startLine = doc.lineAt(from).number;
        const endLine = doc.lineAt(Math.min(to, doc.length)).number;
        for (let n = startLine; n <= endLine; n++) {
            const line = doc.line(n);
            if (isInBlockReplaced(line.from, line.to)) continue;
            const t = line.text;

            const taskM = t.match(PROSE_TASK_RE);
            if (taskM) {
                const bracketStart = line.from + taskM[1].length;
                const bracketEnd = bracketStart + 3;
                const checked = taskM[2] !== ' ';
                pushWidget(
                    Decoration.replace({ widget: new ProseCheckboxWidget(checked, bracketStart, bracketEnd) })
                        .range(bracketStart, bracketEnd)
                );
                if (doc.sliceString(bracketEnd, bracketEnd + 1) === ' ') {
                    pushHide(bracketEnd, bracketEnd + 1);
                }
                continue;
            }

            const bM = t.match(PROSE_BULLET_RE);
            if (bM) {
                const indent = bM[1].length;
                const markStart = line.from + indent;
                const markEnd = markStart + 1 + bM[3].length;
                const ch = bM[2] === '*' ? '◦' : bM[2] === '+' ? '▸' : '•';
                pushWidget(
                    Decoration.replace({ widget: new ProseBulletWidget(ch + ' ') }).range(markStart, markEnd)
                );
                continue;
            }

            const nM = t.match(PROSE_NUMBER_RE);
            if (nM) {
                const indent = nM[1].length;
                const markStart = line.from + indent;
                const markEnd = markStart + nM[2].length + 1 + nM[4].length;
                pushWidget(
                    Decoration.replace({ widget: new ProseBulletWidget(nM[2] + '. ') }).range(markStart, markEnd)
                );
            }
        }

        // Embeds: ![[file]] becomes a block decoration when alone on its line,
        // otherwise an inline hide.
        const embedRanges = [];
        PROSE_EMBED_RE.lastIndex = 0;
        let em;
        while ((em = PROSE_EMBED_RE.exec(text)) !== null) {
            const start = from + em.index;
            const endE = start + em[0].length;
            if (isInBlockReplaced(start, endE)) continue;
            const line = doc.lineAt(start);
            if (line.text.trim() === em[0]) {
                // Standalone embed line is block-replaced by proseBlockField;
                // record the range so wikilink scanning skips it.
                const lineEnd = line.to + (line.to < doc.length ? 1 : 0);
                embedRanges.push([line.from, lineEnd]);
            } else {
                embedRanges.push([start, endE]);
                pushHide(start, endE);
            }
        }

        // Wikilinks: [[target]] or [[target|alias]]. Hide brackets and
        // alias prefix; the visible result is `target` or `alias`.
        PROSE_WIKILINK_RE.lastIndex = 0;
        let m;
        while ((m = PROSE_WIKILINK_RE.exec(text)) !== null) {
            const start = from + m.index;
            const end = start + m[0].length;
            if (embedRanges.some(([a, b]) => start >= a && end <= b)) continue;
            if (isInBlockReplaced(start, end)) continue;
            const target = m[1];
            const hasAlias = m[2] !== undefined;
            pushHide(start, start + 2);
            pushHide(end - 2, end);
            if (hasAlias) pushHide(start + 2, start + 2 + target.length + 1);
        }

        // Inline math: hide the `$` delimiters around non-empty content.
        PROSE_MATH_RE.lastIndex = 0;
        let mm;
        while ((mm = PROSE_MATH_RE.exec(text)) !== null) {
            const start = from + mm.index;
            const end = start + mm[0].length;
            if (isInBlockReplaced(start, end)) continue;
            pushHide(start, start + 1);
            pushHide(end - 1, end);
        }

        // HTML comments: hide the entire `<!-- ... -->` span. Multi-line
        // comments work because we sliced the visible range as a string.
        PROSE_HTML_COMMENT_RE.lastIndex = 0;
        let hc;
        while ((hc = PROSE_HTML_COMMENT_RE.exec(text)) !== null) {
            const start = from + hc.index;
            const end = start + hc[0].length;
            if (isInBlockReplaced(start, end)) continue;
            pushHide(start, end);
        }
    }

    ranges.sort((a, b) => a.from - b.from || a.to - b.to);
    atomic.sort((a, b) => a.from - b.from || a.to - b.to);
    return {
        decorations: Decoration.set(ranges, true),
        atomic: Decoration.set(atomic, true),
    };
}

const proseViewPlugin = ViewPlugin.fromClass(
    class {
        constructor(view) {
            const built = buildProseDecorations(view);
            this.decorations = built.decorations;
            this.atomic = built.atomic;
            this._lastViewportFrom = view.viewport.from;
            this._lastViewportTo = view.viewport.to;
            this._lastProseOn = view.state.field(proseModeField, false);
        }
        update(u) {
            const proseOn = u.view.state.field(proseModeField, false);
            const proseToggled = proseOn !== this._lastProseOn;
            const viewportChanged =
                u.view.viewport.from !== this._lastViewportFrom ||
                u.view.viewport.to !== this._lastViewportTo;

            if (!proseOn && !proseToggled) {
                if (this.decorations.size !== 0) {
                    this.decorations = Decoration.none;
                    this.atomic = Decoration.none;
                }
                this._lastProseOn = proseOn;
                this._lastViewportFrom = u.view.viewport.from;
                this._lastViewportTo = u.view.viewport.to;
                return;
            }

            if (u.docChanged || viewportChanged || proseToggled) {
                const built = buildProseDecorations(u.view);
                this.decorations = built.decorations;
                this.atomic = built.atomic;
            }

            this._lastProseOn = proseOn;
            this._lastViewportFrom = u.view.viewport.from;
            this._lastViewportTo = u.view.viewport.to;
        }
    },
    {
        decorations: v => v.decorations,
        provide: plugin => EditorView.atomicRanges.of(view => {
            return view.plugin(plugin)?.atomic || Decoration.none;
        }),
    }
);

function proseFindLinkAt(state, pos) {
    const tree = syntaxTree(state);
    for (const probe of [pos, pos - 1, pos + 1]) {
        if (probe < 0 || probe > state.doc.length) continue;
        let node = tree.resolveInner(probe, -1);
        while (node) {
            if (node.type.name === 'Link') return node;
            node = node.parent;
        }
    }
    return null;
}

function proseLinkDisplayText(src) {
    const m = src.match(/^\[([^\]]*)\]\([^)]*\)$/);
    return m ? m[1] : src;
}

function proseFindWikilinkAt(state, pos) {
    const line = state.doc.lineAt(pos);
    PROSE_WIKILINK_RE.lastIndex = 0;
    let m;
    while ((m = PROSE_WIKILINK_RE.exec(line.text)) !== null) {
        const start = line.from + m.index;
        const end = start + m[0].length;
        if (pos >= start && pos <= end) {
            const target = m[1];
            const alias = m[3];
            return { from: start, to: end, text: alias ?? target };
        }
    }
    return null;
}

function proseUnwrapLinkCmd(view) {
    if (!view.state.field(proseModeField, false)) return false;
    const sel = view.state.selection.main;
    if (!sel.empty) return false;

    const wiki = proseFindWikilinkAt(view.state, sel.from);
    if (wiki) {
        view.dispatch({
            changes: { from: wiki.from, to: wiki.to, insert: wiki.text },
            selection: { anchor: wiki.from + wiki.text.length },
            userEvent: 'elegance-prose.unwrap-link',
        });
        return true;
    }

    const link = proseFindLinkAt(view.state, sel.from);
    if (!link) return false;
    const src = view.state.doc.sliceString(link.from, link.to);
    const text = proseLinkDisplayText(src);
    view.dispatch({
        changes: { from: link.from, to: link.to, insert: text },
        selection: { anchor: link.from + text.length },
        userEvent: 'elegance-prose.unwrap-link',
    });
    return true;
}

// Cursor snapping over hidden ranges is delegated entirely to
// CodeMirror's atomicRanges facet (wired in proseViewPlugin's provide).
// The atomic set is computed in lockstep with the decoration set inside
// buildProseDecorations, so the renderer and the cursor stepper can never
// disagree about what's hidden.

const proseKeymap = Prec.high(keymap.of([
    { key: 'Backspace', run: proseUnwrapLinkCmd },
    { key: 'Delete', run: proseUnwrapLinkCmd },
]));

/* === bundled from modals.js === */
class IconPickerModal extends SuggestModal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
        this.allIcons = getIconIds();
        this.setPlaceholder('Search icons\u2026');
    }

    getSuggestions(query) {
        const q = query.toLowerCase();
        if (!q) return this.allIcons.slice(0, 100);
        return this.allIcons.filter(id => id.toLowerCase().includes(q));
    }

    renderSuggestion(iconId, el) {
        el.addClass('elegance-icon-suggestion');
        const svg = getIcon(iconId);
        if (svg) el.appendChild(svg);
        el.createSpan({ text: iconId });
    }

    onChooseSuggestion(iconId) {
        this.onChoose(iconId);
    }
}

class CommandPickerModal extends SuggestModal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder('Search for a command...');
    }
    getSuggestions(query) {
        const q = query.toLowerCase();
        const cmds = Object.values(this.app.commands.commands);
        return cmds.filter(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
            .slice(0, 100);
    }
    renderSuggestion(cmd, el) {
        el.createDiv({ text: cmd.name });
        el.createDiv({ text: cmd.id, cls: 'setting-item-description' });
    }
    onChooseSuggestion(cmd) {
        this.onChoose(cmd.id);
    }
}

/* === bundled from settings.js === */
const DEFAULT_SETTINGS = {
    hiddenProperties: [],
    propertyIcons: {},
    actionIcons: {},
    titleProperty: 'displayTitle',
    hiddenFolders: [],
    folderDisplayNames: {},
    betterEmbeds: true,
    collapseProperties: true,
    reviewFolders: ['Lectures', 'Glossary'],
    proseOn: false,
    hiddenStatusBarItems: [],
    actionButtons: [
        'elegance:open-download-link',
        'iris-course:open-video-link',
        'elegance:open-slideshow',
        'elegance:mark-as-reviewed',
        'elegance:cement-embeds',
    ],
};

class EleganceSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Prose mode')
            .setDesc('Hide markdown syntax (headings, emphasis, links) even on the active line. Toggle anytime via the ribbon icon or command palette.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.proseOn)
                .onChange(async (value) => {
                    this.plugin.settings.proseOn = value;
                    this.plugin.applyProseToAll(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Collapse properties')
            .setDesc('Automatically collapse the frontmatter properties section when opening a note.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.collapseProperties)
                .onChange(async (value) => {
                    this.plugin.settings.collapseProperties = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Better embeds')
            .setDesc('Seamless note embedding with heading hierarchy, click-to-edit, and accent hover bar.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.betterEmbeds)
                .onChange(async (value) => {
                    this.plugin.settings.betterEmbeds = value;
                    await this.plugin.saveSettings();
                    // Reload plugin to apply
                    await this.plugin.app.plugins.disablePlugin('elegance');
                    await this.plugin.app.plugins.enablePlugin('elegance');
                }));

        /* ---------- Action buttons ---------- */
        containerEl.createEl('h3', { text: 'Action buttons' });
        containerEl.createEl('p', {
            text: 'Commands to expose as buttons next to the properties heading. Buttons only show when the command is currently available on the active note.',
            cls: 'setting-item-description',
        });

        const actionButtons = this.plugin.settings.actionButtons;
        for (let i = 0; i < actionButtons.length; i++) {
            const id = actionButtons[i];
            const cmd = this.plugin.app.commands.commands[id];
            const row = new Setting(containerEl)
                .setName(cmd ? cmd.name : id)
                .setDesc(cmd ? id : 'Command not found')
                .addExtraButton(btn => btn
                    .setIcon('arrow-up')
                    .setTooltip('Move up')
                    .setDisabled(i === 0)
                    .onClick(async () => {
                        if (i === 0) return;
                        [actionButtons[i - 1], actionButtons[i]] = [actionButtons[i], actionButtons[i - 1]];
                        await this.plugin.saveSettings();
                        this.plugin.updateActionIcons();
                        this.display();
                    }))
                .addExtraButton(btn => btn
                    .setIcon('arrow-down')
                    .setTooltip('Move down')
                    .setDisabled(i === actionButtons.length - 1)
                    .onClick(async () => {
                        if (i === actionButtons.length - 1) return;
                        [actionButtons[i + 1], actionButtons[i]] = [actionButtons[i], actionButtons[i + 1]];
                        await this.plugin.saveSettings();
                        this.plugin.updateActionIcons();
                        this.display();
                    }))
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Remove')
                    .onClick(async () => {
                        actionButtons.splice(i, 1);
                        await this.plugin.saveSettings();
                        this.plugin.updateActionIcons();
                        this.display();
                    }));
            const effectiveIcon = this.plugin.settings.actionIcons[id] || cmd?.icon || 'terminal';
            const preview = row.settingEl.createSpan({ cls: 'elegance-icon-preview' });
            row.settingEl.querySelector('.setting-item-control').prepend(preview);
            setIcon(preview, effectiveIcon);
            row.addExtraButton(btn => btn
                .setIcon('pencil')
                .setTooltip('Change icon')
                .onClick(() => new IconPickerModal(this.plugin.app, async (iconId) => {
                    this.plugin.settings.actionIcons[id] = iconId;
                    await this.plugin.saveSettings();
                    this.plugin.updateActionIcons();
                    this.display();
                }).open()));
        }

        new Setting(containerEl)
            .setName('Add action button')
            .addButton(btn => btn
                .setButtonText('Pick command')
                .onClick(() => {
                    new CommandPickerModal(this.plugin.app, async (id) => {
                        if (!actionButtons.includes(id)) {
                            actionButtons.push(id);
                            await this.plugin.saveSettings();
                            // Prompt for icon selection (default/fallback = terminal)
                            new IconPickerModal(this.plugin.app, async (iconId) => {
                                this.plugin.settings.actionIcons[id] = iconId;
                                await this.plugin.saveSettings();
                                this.plugin.updateActionIcons();
                                this.display();
                            }).open();
                            this.plugin.updateActionIcons();
                            this.display();
                        }
                    }).open();
                }));

        /* ---------- Review folders ---------- */
        containerEl.createEl('h3', { text: 'Review folders' });
        containerEl.createEl('p', {
            text: 'The "Mark as reviewed" action only appears for notes inside these folders. Leave empty to show it everywhere.',
            cls: 'setting-item-description',
        });

        const reviewFolders = this.plugin.settings.reviewFolders;
        for (let i = 0; i < reviewFolders.length; i++) {
            const folder = reviewFolders[i];
            new Setting(containerEl)
                .setName(folder)
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Remove')
                    .onClick(async () => {
                        this.plugin.settings.reviewFolders.splice(i, 1);
                        await this.plugin.saveSettings();
                        this.plugin.updateActionIcons();
                        this.display();
                    }));
        }

        let newReviewFolder = '';
        new Setting(containerEl)
            .setName('Add folder')
            .addText(text => text
                .setPlaceholder('Folder name')
                .onChange(v => { newReviewFolder = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    const name = newReviewFolder.trim();
                    if (name && !this.plugin.settings.reviewFolders.includes(name)) {
                        this.plugin.settings.reviewFolders.push(name);
                        await this.plugin.saveSettings();
                        this.plugin.updateActionIcons();
                        this.display();
                    }
                }));

        /* ---------- Property icons ---------- */
        containerEl.createEl('h3', { text: 'Property icons' });
        containerEl.createEl('p', {
            text: 'Override the default icon for a frontmatter property. Use any Lucide icon name (e.g. "calendar", "tag", "link", "flask-conical").',
            cls: 'setting-item-description',
        });

        const iconMap = this.plugin.settings.propertyIcons;
        for (const [prop, icon] of Object.entries(iconMap)) {
            const row = new Setting(containerEl)
                .setName(prop)
                .addText(text => text
                    .setValue(icon)
                    .setPlaceholder('Icon name')
                    .onChange(async (value) => {
                        if (value.trim()) {
                            this.plugin.settings.propertyIcons[prop] = value.trim();
                        } else {
                            delete this.plugin.settings.propertyIcons[prop];
                        }
                        await this.plugin.saveSettings();
                        this.plugin.applyPropertyIcons();
                        // Update preview
                        const preview = row.settingEl.querySelector('.elegance-icon-preview');
                        if (preview) setIcon(preview, value.trim() || 'help-circle');
                    }))
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Remove')
                    .onClick(async () => {
                        delete this.plugin.settings.propertyIcons[prop];
                        await this.plugin.saveSettings();
                        this.plugin.applyPropertyIcons();
                        this.display();
                    }));
            // Add icon preview
            const preview = row.settingEl.createSpan({ cls: 'elegance-icon-preview' });
            row.settingEl.querySelector('.setting-item-control').prepend(preview);
            setIcon(preview, icon);
        }

        let newIconProp = '';
        let newIconName = '';
        new Setting(containerEl)
            .setName('Add property icon')
            .addText(text => text
                .setPlaceholder('Property name')
                .onChange(v => { newIconProp = v; }))
            .addText(text => text
                .setPlaceholder('Icon name')
                .onChange(v => { newIconName = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    if (newIconProp.trim() && newIconName.trim()) {
                        this.plugin.settings.propertyIcons[newIconProp.trim().toLowerCase()] = newIconName.trim();
                        await this.plugin.saveSettings();
                        this.plugin.applyPropertyIcons();
                        this.display();
                    }
                }));

        /* ---------- Hidden properties ---------- */
        containerEl.createEl('h3', { text: 'Hidden properties' });
        containerEl.createEl('p', {
            text: 'Properties hidden from the frontmatter panel. Right-click a property icon to hide/unhide, or manage them here.',
            cls: 'setting-item-description',
        });

        const hiddenProps = this.plugin.settings.hiddenProperties;
        for (let i = 0; i < hiddenProps.length; i++) {
            const prop = hiddenProps[i];
            new Setting(containerEl)
                .setName(prop)
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Unhide')
                    .onClick(async () => {
                        this.plugin.settings.hiddenProperties.splice(i, 1);
                        await this.plugin.saveSettings();
                        this.plugin.markHiddenProperties();
                        this.display();
                    }));
        }

        let newHiddenProp = '';
        new Setting(containerEl)
            .setName('Hide property')
            .addText(text => text
                .setPlaceholder('Property name')
                .onChange(v => { newHiddenProp = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    const name = newHiddenProp.trim().toLowerCase();
                    if (name && !this.plugin.settings.hiddenProperties.some(p => p.toLowerCase() === name)) {
                        this.plugin.settings.hiddenProperties.push(name);
                        await this.plugin.saveSettings();
                        this.plugin.markHiddenProperties();
                        this.display();
                    }
                }));

        /* ---------- Hidden folders ---------- */
        containerEl.createEl('h3', { text: 'Hidden folders' });

        const hiddenFolders = this.plugin.settings.hiddenFolders;
        for (let i = 0; i < hiddenFolders.length; i++) {
            const folder = hiddenFolders[i];
            new Setting(containerEl)
                .setName(folder)
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Unhide')
                    .onClick(async () => {
                        this.plugin.settings.hiddenFolders.splice(i, 1);
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.hideExplorerFolders());
                        this.display();
                    }));
        }

        let newHiddenFolder = '';
        new Setting(containerEl)
            .setName('Hide folder')
            .addText(text => text
                .setPlaceholder('Folder name')
                .onChange(v => { newHiddenFolder = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    const name = newHiddenFolder.trim();
                    if (name && !this.plugin.settings.hiddenFolders.includes(name)) {
                        this.plugin.settings.hiddenFolders.push(name);
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.hideExplorerFolders());
                        this.display();
                    }
                }));

        /* ---------- Folder display names ---------- */
        containerEl.createEl('h3', { text: 'Folder display names' });
        containerEl.createEl('p', {
            text: 'Number prefixes (e.g. "1-10, ") and module codes (e.g. "LF111 ") are stripped automatically. Add overrides below for custom names.',
            cls: 'setting-item-description',
        });

        const map = this.plugin.settings.folderDisplayNames;
        for (const [path, name] of Object.entries(map)) {
            new Setting(containerEl)
                .setName(path)
                .addText(text => text
                    .setValue(name)
                    .onChange(async (value) => {
                        if (value.trim()) {
                            this.plugin.settings.folderDisplayNames[path] = value.trim();
                        } else {
                            delete this.plugin.settings.folderDisplayNames[path];
                        }
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.renameExplorerFolders());
                    }))
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Remove override')
                    .onClick(async () => {
                        delete this.plugin.settings.folderDisplayNames[path];
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.renameExplorerFolders());
                        this.display();
                    }));
        }

        let newPath = '';
        let newName = '';
        new Setting(containerEl)
            .setName('Add override')
            .addText(text => text
                .setPlaceholder('Folder path')
                .onChange(v => { newPath = v; }))
            .addText(text => text
                .setPlaceholder('Display name')
                .onChange(v => { newName = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    if (newPath.trim() && newName.trim()) {
                        this.plugin.settings.folderDisplayNames[newPath.trim()] = newName.trim();
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.renameExplorerFolders());
                        this.display();
                    }
                }));

        /* ---------- Hidden status bar items ---------- */
        containerEl.createEl('h3', { text: 'Hidden status bar items' });
        containerEl.createEl('p', {
            text: 'Toggle off items you want to hide from the status bar.',
            cls: 'setting-item-description',
        });

        const statusBar = document.querySelector('.status-bar');
        if (statusBar) {
            const items = statusBar.querySelectorAll('.status-bar-item');
            const hidden = this.plugin.settings.hiddenStatusBarItems;
            for (const item of items) {
                const id = this.plugin.getStatusBarItemId(item);
                if (!id) continue;
                const label = this.plugin.getStatusBarItemLabel(item);
                new Setting(containerEl)
                    .setName(label)
                    .setDesc(id)
                    .addToggle(toggle => toggle
                        .setValue(!hidden.includes(id))
                        .onChange(async (visible) => {
                            const idx = hidden.indexOf(id);
                            if (visible && idx !== -1) {
                                hidden.splice(idx, 1);
                            } else if (!visible && idx === -1) {
                                hidden.push(id);
                            }
                            await this.plugin.saveSettings();
                            this.plugin.hideStatusBarItems();
                        }));
            }
        }
    }
}


class ElegancePlugin extends Plugin {
    async onload() {
        /* ---------- Settings ---------- */
        await this.loadSettings();

        /* ---------- Prose Mode ---------- */
        this.registerEditorExtension([proseModeField, proseBlockField, proseViewPlugin, proseBlockAtomic, proseKeymap]);

        this.app.workspace.onLayoutReady(() => this.applyProseToAll(this.settings.proseOn));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.applyProseToAll(this.settings.proseOn)));
        this.registerEvent(this.app.workspace.on('layout-change', () => this.applyProseToAll(this.settings.proseOn)));
        this.addCommand({
            id: 'toggle-prose-mode',
            name: 'Toggle prose mode',
            callback: () => this.toggleProseMode(),
        });

        /* ---------- Action commands ---------- */
        this.registerActionCommands();
        this.proseRibbonEl = this.addRibbonIcon('book-open', this.settings.proseOn ? 'Exit prose mode' : 'Enter prose mode', () => this.toggleProseMode());

        /* ---------- Frontmatter ---------- */
        document.body.classList.add('elegance-fm-active');
        if (this.settings.collapseProperties) {
            document.body.classList.add('elegance-props-collapsing');
            document.body.classList.add('elegance-props-collapsed');
        }
        this.app.workspace.onLayoutReady(() => {
            this.updateActionIcons();
            this.markHiddenProperties();
            this.applyPropertyIcons();
            this.updateAllDisplayTitles();
            this.withExplorerPaused(() => this.updateExplorerFolders());
            this.setupExplorerObserver();
            this.setupPropertyIconObserver();
            this.hideStatusBarItems();
            setTimeout(() => this.collapseAllProperties(), 200);
        });

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (this.settings.collapseProperties) {
                    document.body.classList.add('elegance-props-collapsing');
                }
                if (this.settings.titleProperty) {
                    document.body.classList.add('elegance-title-swapping');
                }
                this.refreshNoteUI();
                if (this.settings.titleProperty) {
                    requestAnimationFrame(() => {
                        this.updateAllDisplayTitles();
                        document.body.classList.remove('elegance-title-swapping');
                    });
                }
                setTimeout(() => this.collapseAllProperties(), 50);
            })
        );
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (file === this.app.workspace.getActiveFile()) {
                    this.updateActionIcons();
                    this.markHiddenProperties();
                    this.applyPropertyIcons();
                }
                this.updateDisplayTitleForFile(file);
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                this.handleRename(file, oldPath);
            })
        );
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                clearTimeout(this.displayTitleTimeout);
                this.displayTitleTimeout = setTimeout(() => {
                    this.updateAllDisplayTitles();
                    this.markHiddenProperties();
                    this.applyPropertyIcons();
                    if (!this.explorerObserver) this.setupExplorerObserver();
                    this.withExplorerPaused(() => this.updateExplorerFolders());
                    this.hideStatusBarItems();
                }, 100);
            })
        );

        /* ---------- Hidden Properties ---------- */
        this.addCommand({
            id: 'toggle-hidden-properties',
            name: 'Toggle hidden properties',
            callback: () => {
                document.body.classList.toggle('elegance-show-hidden');
            }
        });

        /* ---------- Better Embeds ---------- */
        if (this.settings.betterEmbeds) {
            this.processedEmbeds = new WeakSet();
            this.embedProcessTimeout = null;

            this.setupEmbedObserver();

            this.app.workspace.onLayoutReady(() => {
                setTimeout(() => this.processAllVisibleEmbeds(), 300);
            });

            this.registerEvent(
                this.app.workspace.on('active-leaf-change', () => {
                    setTimeout(() => this.processAllVisibleEmbeds(), 200);
                })
            );

            this.registerEvent(
                this.app.workspace.on('layout-change', () => {
                    clearTimeout(this.embedProcessTimeout);
                    this.embedProcessTimeout = setTimeout(() => this.processAllVisibleEmbeds(), 150);
                })
            );
        }

        /* ---------- Property icon context menu ---------- */
        // Use capture phase so we intercept before Obsidian's handler creates its menu,
        // then monkey-patch Menu.showAtMouseEvent to inject our items into that menu.
        const iconContextHandler = (e) => {
            const iconEl = e.target.closest('.metadata-property-icon');
            if (!iconEl) return;
            const propEl = iconEl.closest('.metadata-property');
            if (!propEl) return;
            const key = propEl.getAttribute('data-property-key');
            if (!key) return;

            const plugin = this;
            let injected = false;
            const origShow = Menu.prototype.showAtMouseEvent;

            Menu.prototype.showAtMouseEvent = function(event) {
                injected = true;
                Menu.prototype.showAtMouseEvent = origShow;
                this.addSeparator();
                plugin._addIconMenuItems(this, key);
                origShow.call(this, event);
            };

            // Safety: restore patch if Obsidian doesn't create a menu this tick
            setTimeout(() => {
                Menu.prototype.showAtMouseEvent = origShow;
                if (!injected) {
                    // No Obsidian menu was created — show our own
                    e.preventDefault();
                    const menu = new Menu();
                    plugin._addIconMenuItems(menu, key);
                    menu.showAtMouseEvent(e);
                }
            }, 0);
        };
        document.addEventListener('contextmenu', iconContextHandler, true);
        this.register(() => document.removeEventListener('contextmenu', iconContextHandler, true));

        /* ---------- Settings ---------- */
        this.addSettingTab(new EleganceSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async toggleProseMode() {
        this.settings.proseOn = !this.settings.proseOn;
        this.applyProseToAll(this.settings.proseOn);
        if (this.proseRibbonEl) {
            const label = this.settings.proseOn ? 'Exit prose mode' : 'Enter prose mode';
            this.proseRibbonEl.setAttribute('aria-label', label);
            this.proseRibbonEl.setAttribute('data-tooltip', label);
        }
        await this.saveSettings();
        new Notice(`Prose mode ${this.settings.proseOn ? 'on' : 'off'}`);
    }

    applyProseToAll(on) {
        document.body.classList.toggle('elegance-prose-on', !!on);
        this.app.workspace.iterateAllLeaves(leaf => {
            const view = leaf.view;
            const cm = view?.editor?.cm;
            if (!cm) return;
            if (cm.state.field(proseModeField, false) === on) return;
            cm.dispatch({ effects: setProseMode.of(on) });
        });
    }

/** Run the standard set of per-note refreshes (icons, hidden props, titles). */
    refreshNoteUI() {
        this.updateActionIcons();
        this.markHiddenProperties();
        this.applyPropertyIcons();
        this.updateAllDisplayTitles();
    }

    /* ============================================================
       Status bar — hide items
       ============================================================ */

    getStatusBarItemId(el) {
        for (const cls of el.classList) {
            if (cls !== 'status-bar-item' && cls.startsWith('plugin-')) return cls;
        }
        const text = el.textContent.trim().slice(0, 50);
        return text || null;
    }

    getStatusBarItemLabel(el) {
        for (const cls of el.classList) {
            if (cls !== 'status-bar-item' && cls.startsWith('plugin-')) {
                return cls.replace('plugin-', '').replace(/-/g, ' ');
            }
        }
        return el.textContent.trim().slice(0, 50) || '(empty)';
    }

    hideStatusBarItems() {
        const hidden = this.settings.hiddenStatusBarItems || [];
        const statusBar = document.querySelector('.status-bar');
        if (!statusBar) return;
        for (const item of statusBar.querySelectorAll('.status-bar-item')) {
            const id = this.getStatusBarItemId(item);
            item.classList.toggle('elegance-statusbar-hidden', !!(id && hidden.includes(id)));
        }
    }

    onunload() {
        for (const cls of [
            'elegance-fm-active',
            'elegance-show-hidden',
            'elegance-props-collapsing',
            'elegance-props-collapsed',
            'elegance-title-swapping',
            'elegance-prose-on',
        ]) document.body.classList.remove(cls);

        for (const sel of [
            '.elegance-fm-action',
            '.elegance-embed-title',
            '.elegance-embed-btn',
        ]) document.querySelectorAll(sel).forEach(el => el.remove());

        document.querySelectorAll('.elegance-statusbar-hidden').forEach(el => {
            el.classList.remove('elegance-statusbar-hidden');
        });
        document.querySelectorAll('.elegance-prop-hidden').forEach(el => {
            el.classList.remove('elegance-prop-hidden');
        });
        document.querySelectorAll('.metadata-property-icon[data-elegance-original-icon]').forEach(el => {
            el.innerHTML = el.getAttribute('data-elegance-original-icon');
            el.removeAttribute('data-elegance-original-icon');
            el.removeAttribute('data-elegance-icon');
        });

        this.restoreAllDisplayTitles();
        this.restoreExplorerFolders();

        document.querySelectorAll('.elegance-embed-seamless').forEach(el => {
            el.classList.remove('elegance-embed-seamless');
        });
    }

    /* ============================================================
       Frontmatter — action icons
       ============================================================ */

    registerActionCommands() {
        this.addCommand({
            id: 'open-slideshow',
            name: 'Open slideshow',
            icon: 'monitor-play',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;
                const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.slides;
                if (!raw || typeof raw !== 'string' || !raw.trim()) return false;
                const path = this.resolveSlidesPath(raw, file);
                if (!path || typeof path !== 'string') return false;
                if (!checking) this.openSlideshow(path.trim(), file);
                return true;
            },
        });

        this.addCommand({
            id: 'mark-as-reviewed',
            name: 'Mark as reviewed',
            icon: 'check-circle',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;
                const folders = this.settings.reviewFolders;
                const ok = folders.length === 0 || folders.some(f => file.path.startsWith(f + '/'));
                if (!ok) return false;
                if (!checking) this.setLastReviewed(file);
                return true;
            },
        });

        this.addCommand({
            id: 'cement-embeds',
            name: 'Cement embeds',
            icon: 'anchor',
            checkCallback: (checking) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!view || !view.file) return false;
                const mode = view.getMode?.() ?? view.currentMode?.type;
                if (mode !== 'source') return false;
                const file = view.file;
                const cache = this.app.metadataCache.getFileCache(file);
                const has = cache?.embeds?.some(e => {
                    const dest = this.app.metadataCache.getFirstLinkpathDest(e.link.split('#')[0], file.path);
                    return dest && dest.extension === 'md';
                });
                if (!has) return false;
                if (!checking) this.cementAllEmbeds(file);
                return true;
            },
        });
    }

    updateActionIcons() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        // Only clear icons in the active view's container, so inactive leaves
        // keep their previously-rendered icons until they next become active.
        if (!view?.containerEl) return;
        view.containerEl.querySelectorAll('.elegance-fm-actions').forEach(el => el.remove());

        const ids = this.settings.actionButtons || [];
        if (!ids.length) return;

        if (!view) return;
        const heading = view.containerEl?.querySelector('.metadata-properties-heading');
        if (!heading) return;

        const titleEl = heading.querySelector('.metadata-properties-title');
        const titleCs = titleEl ? getComputedStyle(titleEl) : null;
        const titleColor = titleCs ? titleCs.color : null;
        const titleW = titleCs ? titleCs.width : null;
        const titleH = titleCs ? titleCs.height : null;

        heading.parentElement.classList.add('elegance-fm-heading-row');
        let container = heading.parentElement.querySelector(':scope > .elegance-fm-actions');
        if (!container) {
            container = document.createElement('div');
            container.className = 'elegance-fm-actions';
            heading.insertAdjacentElement('afterend', container);
        }
        container.innerHTML = '';
        // Mirror the heading's box + internal spacing so the two siblings
        // render as if they were a single continuous row.
        const cs = getComputedStyle(heading);
        const gap = cs.columnGap && cs.columnGap !== 'normal' ? cs.columnGap : cs.gap;
        Object.assign(container.style, {
            height: cs.height,
            minHeight: cs.minHeight,
            marginTop: cs.marginTop,
            marginBottom: cs.marginBottom,
            marginLeft: gap || cs.gap || '7px',
            paddingTop: cs.paddingTop,
            paddingBottom: cs.paddingBottom,
            paddingLeft: '0px',
            paddingRight: cs.paddingRight,
            gap: gap || cs.gap || '7px',
            font: cs.font,
            lineHeight: cs.lineHeight,
            boxSizing: cs.boxSizing,
        });

        for (const id of ids) {
            const cmd = this.app.commands.commands[id];
            if (!cmd) continue;

            let available = true;
            if (typeof cmd.checkCallback === 'function') {
                available = !!cmd.checkCallback(true);
            } else if (typeof cmd.editorCheckCallback === 'function') {
                const editor = view.editor;
                available = editor ? !!cmd.editorCheckCallback(true, editor, view) : false;
            }
            if (!available) continue;

            const icon = document.createElement('span');
            icon.className = 'elegance-fm-action';
            icon.setAttribute('aria-label', cmd.name.replace(/^[^:]+:\s*/, ''));
            icon.dataset.commandId = id;
            const iconName = this.settings.actionIcons[id] || cmd.icon || 'terminal';
            setIcon(icon, iconName);
            icon.addEventListener('click', () => {
                this.app.commands.executeCommandById(id);
            });
            icon.addEventListener('contextmenu', (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
                const menu = new Menu();
                menu.addItem(item => item
                    .setTitle('Change icon')
                    .setIcon('pencil')
                    .onClick(() => new IconPickerModal(this.app, async (iconId) => {
                        this.settings.actionIcons[id] = iconId;
                        await this.saveSettings();
                        this.updateActionIcons();
                    }).open()));
                if (this.settings.actionIcons[id]) {
                    menu.addItem(item => item
                        .setTitle('Reset icon')
                        .setIcon('rotate-ccw')
                        .onClick(async () => {
                            delete this.settings.actionIcons[id];
                            await this.saveSettings();
                            this.updateActionIcons();
                        }));
                }
                menu.showAtMouseEvent(evt);
            });
            if (titleColor) icon.style.color = titleColor;
            if (titleW) icon.style.width = titleW;
            if (titleH) icon.style.height = titleH;
            const svg = icon.querySelector('svg');
            if (svg && titleW && titleH) {
                svg.style.width = titleW;
                svg.style.height = titleH;
            }
            container.appendChild(icon);
        }
    }

    clearActionIcons() {
        document.querySelectorAll('.elegance-fm-actions').forEach(el => el.remove());
    }

    /**
     * Resolve a slides property to a vault path.
     * Supports:
     *   - Plain vault path:  "Lectures/slides.pdf"
     *   - Direct wiki-link to a file:  "[[Lectures/slides.pdf]]"
     *   - Indirect wiki-link to a note whose own `slides` property holds the
     *     real path (mirrors how video handles Echo360 indirection).
     */
    resolveSlidesPath(raw, sourceFile) {
        if (!raw || typeof raw !== 'string') return raw;
        const m = raw.trim().match(/^\[\[([^\]]+)\]\]$/);
        if (!m) return raw.trim();
        const linkPath = m[1].split('#')[0].split('|')[0];
        const target = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
        if (!target) return raw;
        // If the target is already a PDF/PPTX, use it directly
        if (/\.(pdf|pptx)$/i.test(target.path)) return target.path;
        // Otherwise treat it as an intermediary note — read its `slides` frontmatter
        const fm = this.app.metadataCache.getFileCache(target)?.frontmatter;
        if (fm?.slides && typeof fm.slides === 'string') {
            return this.resolveSlidesPath(fm.slides, target);
        }
        return target.path;
    }

    /** Open a PDF in the pptx-viewer slideshow view. */
    async openSlideshow(vaultPath, sourceFile) {
        if (!vaultPath) return;
        const file = this.app.vault.getAbstractFileByPath(vaultPath);
        if (!file) {
            new Notice(`Slideshow not found: ${vaultPath}`);
            return;
        }
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({
            type: 'pdf-slideshow',
            state: { file: file.path },
        });
    }

    async setLastReviewed(file) {
        if (!file) return;
        const now = window.moment().format('YYYY-MM-DDTHH:mm');
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm['last-reviewed'] = now;
        });
    }


    /** Add "Change icon" / "Reset icon" items to a Menu for the given property key */
    _addIconMenuItems(menu, key) {
        menu.addItem(item => {
            item.setTitle('Change icon')
                .setIcon('pencil')
                .onClick(() => new IconPickerModal(this.app, async (iconId) => {
                    this.settings.propertyIcons[key.toLowerCase()] = iconId;
                    await this.saveSettings();
                    this.applyPropertyIcons();
                }).open());
        });
        const lowerKey = key.toLowerCase();
        if (this.settings.propertyIcons[lowerKey]) {
            menu.addItem(item => {
                item.setTitle('Reset icon')
                    .setIcon('rotate-ccw')
                    .onClick(async () => {
                        delete this.settings.propertyIcons[lowerKey];
                        await this.saveSettings();
                        this.applyPropertyIcons();
                    });
            });
        }

        const isHidden = this.settings.hiddenProperties
            .some(p => p.toLowerCase() === lowerKey);
        menu.addItem(item => {
            item.setTitle(isHidden ? 'Unhide property' : 'Hide property')
                .setIcon(isHidden ? 'eye' : 'eye-off')
                .onClick(async () => {
                    if (isHidden) {
                        this.settings.hiddenProperties = this.settings.hiddenProperties
                            .filter(p => p.toLowerCase() !== lowerKey);
                    } else {
                        this.settings.hiddenProperties.push(lowerKey);
                    }
                    await this.saveSettings();
                    this.markHiddenProperties();
                });
        });
    }

    /* ============================================================
       Collapse Properties — auto-collapse on note open
       ============================================================ */

    collapseAllProperties() {
        if (!this.settings.collapseProperties) {
            document.body.classList.remove('elegance-props-collapsing');
            return;
        }
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const container = leaf.view?.containerEl?.querySelector('.metadata-container');
            if (container && !container.classList.contains('is-collapsed')) {
                const heading = container.querySelector('.metadata-properties-heading');
                if (heading) heading.click();
            }
        });
        document.body.classList.remove('elegance-props-collapsing');
    }

    /* ============================================================
       Hidden Properties
       ============================================================ */

    markHiddenProperties() {
        const hidden = this.settings.hiddenProperties;
        const hiddenSet = hidden?.length
            ? new Set(hidden.map(p => p.toLowerCase()))
            : null;

        document.querySelectorAll('.metadata-property').forEach(el => {
            const key = el.getAttribute('data-property-key');
            if (hiddenSet && key && hiddenSet.has(key.toLowerCase())) {
                el.classList.add('elegance-prop-hidden');
            } else {
                el.classList.remove('elegance-prop-hidden');
            }
        });
    }

    /* ============================================================
       Property Icons — custom Lucide icons per property
       ============================================================ */

    setupPropertyIconObserver() {
        if (this._propIconObserver) this._propIconObserver.disconnect();

        this._propIconPaused = false;
        this._propIconTimer = null;

        this._propIconObserver = new MutationObserver(() => {
            if (this._propIconPaused) return;
            clearTimeout(this._propIconTimer);
            this._propIconTimer = setTimeout(() => this.applyPropertyIcons(), 80);
        });

        // Observe all workspace leaves so we catch metadata panels in any pane
        const container = document.querySelector('.workspace');
        if (container) {
            this._propIconObserver.observe(container, {
                childList: true,
                subtree: true,
            });
        }

        this.register(() => this._propIconObserver?.disconnect());
    }

    applyPropertyIcons() {
        // Pause observer so our own setIcon() calls don't re-trigger it.
        // MutationObserver callbacks are microtasks, so they fire before the
        // setTimeout macrotask that unpauses — guaranteeing our mutations are
        // ignored while external (Obsidian) mutations after we finish are not.
        this._propIconPaused = true;

        const icons = this.settings.propertyIcons;
        const lookup = {};
        if (icons) {
            for (const [key, icon] of Object.entries(icons)) {
                lookup[key.toLowerCase()] = icon;
            }
        }

        document.querySelectorAll('.metadata-property').forEach(el => {
            const key = el.getAttribute('data-property-key');
            if (!key) return;

            const iconName = lookup[key.toLowerCase()];
            const iconEl = el.querySelector('.metadata-property-icon');
            if (!iconEl) return;

            if (iconName) {
                if (!iconEl.hasAttribute('data-elegance-original-icon')) {
                    iconEl.setAttribute('data-elegance-original-icon', iconEl.innerHTML);
                }
                // Always re-apply — Obsidian can overwrite the SVG children
                // without clearing our data attribute
                setIcon(iconEl, iconName);
                iconEl.setAttribute('data-elegance-icon', iconName);
            } else {
                const original = iconEl.getAttribute('data-elegance-original-icon');
                if (original) {
                    iconEl.innerHTML = original;
                    iconEl.removeAttribute('data-elegance-original-icon');
                    iconEl.removeAttribute('data-elegance-icon');
                }
            }
        });

        // Unpause after our mutation observer callbacks have been delivered
        setTimeout(() => { this._propIconPaused = false; }, 0);
    }

    /* ============================================================
       Display Title — frontmatter-driven title override
       ============================================================ */

    getDisplayTitle(file) {
        if (!file) return null;
        const prop = this.settings.titleProperty;
        if (!prop) return null;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        return fm?.[prop] ?? null;
    }

    /** Update display titles. If `file` is given, only update leaves for that file. */
    updateDisplayTitles(file = null) {
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            if (file && leaf.view?.file?.path !== file.path) return;
            this.updateLeafDisplayTitle(leaf);
        });
        this.withExplorerPaused(() => this.updateExplorerTitles());
    }

    updateAllDisplayTitles() { this.updateDisplayTitles(); }
    updateDisplayTitleForFile(file) { this.updateDisplayTitles(file); }

    updateLeafDisplayTitle(leaf) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || !view.file) return;

        const title = this.getDisplayTitle(view.file);
        const originalName = view.file.basename;

        // Inline title — skip if the user is actively editing it
        const inlineTitleEl = view.containerEl.querySelector('.inline-title');
        if (inlineTitleEl && !inlineTitleEl.matches(':focus')) {
            const target = title || originalName;
            if (inlineTitleEl.textContent !== target) {
                inlineTitleEl.textContent = target;
            }
        }

        // Tab title
        const tabTitleEl = leaf.tabHeaderInnerTitleEl;
        if (tabTitleEl) {
            const target = title || originalName;
            if (tabTitleEl.textContent !== target) {
                tabTitleEl.textContent = target;
            }
        }
    }

    updateExplorerTitles() {
        const prop = this.settings.titleProperty;
        if (!prop) return;

        document.querySelectorAll('.nav-file-title').forEach(el => {
            const path = el.getAttribute('data-path');
            if (!path) return;

            const file = this.app.vault.getAbstractFileByPath(path);
            if (!file) return;

            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const displayTitle = fm?.[prop];
            const contentEl = el.querySelector('.nav-file-title-content');
            if (!contentEl) return;

            if (displayTitle) {
                if (!contentEl.hasAttribute('data-elegance-original')) {
                    contentEl.setAttribute('data-elegance-original', contentEl.textContent);
                }
                if (contentEl.textContent !== displayTitle) {
                    contentEl.textContent = displayTitle;
                }
            } else {
                const original = contentEl.getAttribute('data-elegance-original');
                if (original && contentEl.textContent !== original) {
                    contentEl.textContent = original;
                }
                contentEl.removeAttribute('data-elegance-original');
            }
        });
    }

    setupExplorerObserver() {
        const explorerEl = document.querySelector('.nav-files-container');
        if (!explorerEl) return;
        if (this.explorerObserver) this.explorerObserver.disconnect();

        // Immediately apply folder hiding/renaming to avoid flash of original names
        this.hideExplorerFolders();
        this.renameExplorerFolders();

        this._explorerPaused = false;
        this._explorerRafPending = false;

        this.explorerObserver = new MutationObserver(() => {
            if (this._explorerPaused) return;
            if (!this._explorerRafPending) {
                this._explorerRafPending = true;
                requestAnimationFrame(() => {
                    this._explorerRafPending = false;
                    this.withExplorerPaused(() => {
                        this.updateExplorerTitles();
                        this.updateExplorerFolders();
                    });
                });
            }
        });

        this.explorerObserver.observe(explorerEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'data-path'],
        });

        this.register(() => this.explorerObserver?.disconnect());
    }

    /** Run fn while the explorer observer is paused to avoid feedback loops */
    withExplorerPaused(fn) {
        this._explorerPaused = true;
        try { fn(); } finally { this._explorerPaused = false; }
    }

    /* ============================================================
       Explorer Folders — hiding and display names
       ============================================================ */

    updateExplorerFolders() {
        this.hideExplorerFolders();
        this.renameExplorerFolders();
    }

    hideExplorerFolders() {
        const hidden = this.settings.hiddenFolders;
        const hiddenSet = hidden?.length
            ? new Set(hidden.map(f => f.toLowerCase()))
            : null;

        document.querySelectorAll('.nav-folder').forEach(el => {
            const titleEl = el.querySelector(':scope > .nav-folder-title');
            if (!titleEl) return;
            const path = titleEl.getAttribute('data-path');
            if (!path) return;

            // Match on the folder's own name (last segment of path)
            const name = path.split('/').pop().toLowerCase();
            if (hiddenSet && hiddenSet.has(name)) {
                el.classList.add('elegance-folder-hidden');
            } else {
                el.classList.remove('elegance-folder-hidden');
            }
        });
    }

    /** Strip common prefixes from folder names (number ranges, module codes) */
    cleanFolderName(name) {
        let cleaned = name;
        // Strip leading number range: "1-10, " or "5, "
        cleaned = cleaned.replace(/^\d+(-\d+)?,\s*/, '');
        // Strip leading module code: "LF111 " or "CH171 "
        cleaned = cleaned.replace(/^[A-Z]{2,}\d{3,}\s+/, '');
        return cleaned;
    }

    renameExplorerFolders() {
        const map = this.settings.folderDisplayNames;
        // Build a lowercase lookup for case-insensitive matching
        const lookup = {};
        if (map) {
            for (const [path, name] of Object.entries(map)) {
                lookup[path.toLowerCase()] = name;
            }
        }

        document.querySelectorAll('.nav-folder-title').forEach(el => {
            const path = el.getAttribute('data-path');
            if (!path) return;
            const contentEl = el.querySelector('.nav-folder-title-content');
            if (!contentEl) return;

            // Explicit override takes priority
            let displayName = lookup[path.toLowerCase()];

            // Fall back to auto-cleaned name
            if (!displayName) {
                const folderName = path.split('/').pop();
                const cleaned = this.cleanFolderName(folderName);
                if (cleaned !== folderName) displayName = cleaned;
            }

            if (displayName) {
                if (!contentEl.hasAttribute('data-elegance-original')) {
                    contentEl.setAttribute('data-elegance-original', contentEl.textContent);
                }
                if (contentEl.textContent !== displayName) {
                    contentEl.textContent = displayName;
                }
            } else {
                const original = contentEl.getAttribute('data-elegance-original');
                if (original && contentEl.textContent !== original) {
                    contentEl.textContent = original;
                }
                contentEl.removeAttribute('data-elegance-original');
            }
        });
    }

    restoreExplorerFolders() {
        document.querySelectorAll('.elegance-folder-hidden').forEach(el => {
            el.classList.remove('elegance-folder-hidden');
        });
        document.querySelectorAll('.nav-folder-title-content[data-elegance-original]').forEach(el => {
            el.textContent = el.getAttribute('data-elegance-original');
            el.removeAttribute('data-elegance-original');
        });
    }

    restoreAllDisplayTitles() {
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || !view.file) return;
            const name = view.file.basename;

            const inlineTitleEl = view.containerEl.querySelector('.inline-title');
            if (inlineTitleEl && inlineTitleEl.textContent !== name) {
                inlineTitleEl.textContent = name;
            }

            const tabTitleEl = leaf.tabHeaderInnerTitleEl;
            if (tabTitleEl && tabTitleEl.textContent !== name) {
                tabTitleEl.textContent = name;
            }
        });

        // Restore explorer titles
        document.querySelectorAll('.nav-file-title-content[data-elegance-original]').forEach(el => {
            el.textContent = el.getAttribute('data-elegance-original');
            el.removeAttribute('data-elegance-original');
        });
    }

    /* ============================================================
       Rename handling — refresh stale original-name attributes
       ============================================================ */

    handleRename(file, oldPath) {
        // Refresh explorer file titles — update stored original name for renamed items
        document.querySelectorAll('.nav-file-title-content[data-elegance-original]').forEach(el => {
            const titleEl = el.closest('.nav-file-title');
            if (titleEl?.getAttribute('data-path') === file.path) {
                el.setAttribute('data-elegance-original', file.basename || file.name);
            }
        });

        // Refresh explorer folder titles
        document.querySelectorAll('.nav-folder-title-content[data-elegance-original]').forEach(el => {
            const titleEl = el.closest('.nav-folder-title');
            if (titleEl?.getAttribute('data-path') === file.path) {
                el.setAttribute('data-elegance-original', file.name);
            }
        });

        // Re-run display title updates for the renamed file
        this.updateDisplayTitleForFile(file);
    }

    /* ============================================================
       Better Embeds — seamless note embedding
       ============================================================ */

    setupEmbedObserver() {
        const workspaceEl = this.app.workspace.containerEl;

        this.embedObserver = new MutationObserver((mutations) => {
            let shouldProcess = false;

            for (const mutation of mutations) {
                if (mutation.type === 'attributes' &&
                    mutation.target.classList &&
                    mutation.target.classList.contains('markdown-embed') &&
                    mutation.target.classList.contains('is-loaded')) {
                    shouldProcess = true;
                    break;
                }

                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            if ((node.classList && node.classList.contains('markdown-embed')) ||
                                (node.querySelector && node.querySelector('.markdown-embed.is-loaded'))) {
                                shouldProcess = true;
                                break;
                            }
                        }
                    }
                    if (shouldProcess) break;
                }
            }

            if (shouldProcess) {
                clearTimeout(this.embedProcessTimeout);
                this.embedProcessTimeout = setTimeout(() => this.processAllVisibleEmbeds(), 50);
            }
        });

        this.embedObserver.observe(workspaceEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });

        this.register(() => this.embedObserver.disconnect());
    }

    processAllVisibleEmbeds() {
        const embeds = document.querySelectorAll('.markdown-embed.is-loaded');
        for (const embed of embeds) {
            if (!this.processedEmbeds.has(embed)) {
                if (embed.closest('.hover-popover')) continue;
                this.processEmbed(embed);
                this.processedEmbeds.add(embed);
            }
        }
    }

    processEmbed(embed) {
        const content = embed.querySelector(':scope > .markdown-embed-content');
        if (!content) return;

        const contextLevel = this.findContextHeadingLevel(embed);
        const titleLevel = Math.min(contextLevel + 1, 6);

        // Replace the title with a proper heading
        const titleEl = embed.querySelector(':scope > .markdown-embed-title');
        const titleText = titleEl ? titleEl.textContent.trim() : '';

        if (titleText) {
            const heading = document.createElement('h' + titleLevel);
            heading.textContent = titleText;
            heading.className = 'elegance-embed-title';
            titleEl.after(heading);
        }

        // Shift content headings so they're sub-headings of the title
        const allHeadings = content.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const ownHeadings = [];
        for (const h of allHeadings) {
            if (h.closest('.markdown-embed') === embed) {
                ownHeadings.push(h);
            }
        }

        if (ownHeadings.length > 0) {
            let minLevel = 6;
            for (const h of ownHeadings) {
                const level = parseInt(h.tagName[1]);
                if (level < minLevel) minLevel = level;
            }

            const targetTopLevel = titleText ? titleLevel + 1 : titleLevel;
            const shift = targetTopLevel - minLevel;

            if (shift > 0) {
                for (const h of ownHeadings) {
                    const oldLevel = parseInt(h.tagName[1]);
                    const newLevel = Math.min(oldLevel + shift, 6);
                    if (newLevel !== oldLevel) {
                        const newH = document.createElement('h' + newLevel);
                        for (const attr of h.attributes) {
                            newH.setAttribute(attr.name, attr.value);
                        }
                        newH.innerHTML = h.innerHTML;
                        h.replaceWith(newH);
                    }
                }
            }
        }

        // Add nav / snap / delete buttons
        const src = embed.getAttribute('src') ||
                    embed.closest('.internal-embed')?.getAttribute('src') || '';
        if (src) {
            const makeBtn = (cls, label, icon, handler) => {
                const btn = document.createElement('span');
                btn.className = `elegance-embed-btn ${cls}`;
                btn.setAttribute('aria-label', label);
                setIcon(btn, icon);
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handler(e);
                });
                embed.prepend(btn);
                return btn;
            };

            makeBtn('elegance-embed-nav-btn', 'Open note', 'maximize-2', () => {
                const file = this.app.metadataCache.getFirstLinkpathDest(src.split('#')[0], '');
                if (file) this.app.workspace.openLinkText(file.path, '', false);
            });

            makeBtn('elegance-embed-snap-btn', 'Replace embed with content', 'anchor', async () => {
                const linkPath = src.split('#')[0];
                const subpath = src.includes('#') ? src.split('#').slice(1).join('#') : '';
                const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, '');
                if (!file) { new Notice('Cannot resolve embedded file.'); return; }

                const located = this.findEmbedInEditor(embed, src);
                if (!located) return;
                const { editor, from, to, scrollInfo } = located;

                let embeddedContent;
                try {
                    embeddedContent = await this.app.vault.cachedRead(file);
                } catch {
                    new Notice('Could not read embedded file.');
                    return;
                }
                embeddedContent = embeddedContent.replace(/^---\n[\s\S]*?\n---\n?/, '');
                if (subpath) {
                    embeddedContent = this.extractSection(embeddedContent, subpath);
                    if (!embeddedContent) {
                        new Notice('Could not find section "' + subpath + '" in file.');
                        return;
                    }
                }

                const contextLevel = this.findContextHeadingLevel(embed);
                const titleLevel = Math.min(contextLevel + 1, 6);
                const titleText = subpath || file.basename;
                const titleLine = '#'.repeat(titleLevel) + ' ' + titleText;
                const shifted = this.shiftHeadingsInText(embeddedContent, titleLevel + 1);
                const finalContent = titleLine + '\n' + shifted;

                editor.replaceRange(finalContent.trimEnd(), from, to);
                requestAnimationFrame(() => editor.scrollTo(scrollInfo.left, scrollInfo.top));
                new Notice('Embed replaced with content snapshot.');
            });

            makeBtn('elegance-embed-del-btn', 'Delete embed', 'trash-2', () => {
                const located = this.findEmbedInEditor(embed, src);
                if (!located) return;
                const { editor, from, to, scrollInfo } = located;
                editor.replaceRange('', from, to);
                requestAnimationFrame(() => editor.scrollTo(scrollInfo.left, scrollInfo.top));
                new Notice('Embed deleted.');
            });
        }

        // Click-to-edit: track hover position, then open source at that exact caret
        if (src) {
            let hoverInfo = null;

            // Continuously track the character position under the mouse
            embed.addEventListener('mousemove', (e) => {
                const range = document.caretRangeFromPoint(e.clientX, e.clientY);
                if (!range || !range.startContainer || range.startContainer.nodeType !== 3) {
                    hoverInfo = null;
                    return;
                }
                const text = range.startContainer.textContent;
                const off = range.startOffset;
                // Grab up to 20 chars either side of the caret for a unique search key
                const start = Math.max(0, off - 20);
                const end = Math.min(text.length, off + 20);
                hoverInfo = {
                    searchText: text.substring(start, end),
                    caretInSearch: off - start,
                };
            });

            embed.addEventListener('click', (e) => {
                if (e.target.closest('.elegance-embed-nav-btn') || e.target.closest('.elegance-embed-snap-btn') || e.target.closest('.elegance-embed-del-btn')) return;
                if (e.target.closest('a')) return;

                const file = this.app.metadataCache.getFirstLinkpathDest(src.split('#')[0], '');
                if (!file) return;

                const snapHover = hoverInfo;
                const clickY = e.clientY;

                // Reuse an existing tab if the file is already open
                const existing = this.app.workspace.getLeavesOfType('markdown')
                    .find(l => l.view?.file?.path === file.path);
                const leaf = existing || this.app.workspace.getLeaf('tab');

                const positionCursor = () => {
                    if (!(leaf.view instanceof MarkdownView)) return;
                    const view = leaf.view;

                    // Switch to source/live-preview so the editor is available
                    const state = view.getState();
                    if (state.mode === 'preview') {
                        state.mode = 'source';
                        view.setState(state, { history: false });
                    }

                    if (!snapHover) return;
                    const editor = view.editor;
                    const content = editor.getValue();
                    const idx = content.indexOf(snapHover.searchText);
                    if (idx !== -1) {
                        const caretIdx = idx + snapHover.caretInSearch;
                        const pos = editor.offsetToPos(caretIdx);
                        editor.setCursor(pos);

                        // Scroll the caret line to the same screen-Y as the click
                        const cm = editor.cm;
                        if (cm) {
                            const rect = cm.coordsAtPos(cm.state.selection.main.head);
                            if (rect) {
                                const scrollEl = cm.scrollDOM;
                                const offsetInScroller = clickY - scrollEl.getBoundingClientRect().top;
                                scrollEl.scrollTop += rect.top - scrollEl.getBoundingClientRect().top - offsetInScroller;
                            }
                        } else {
                            editor.scrollIntoView({ from: pos, to: pos }, true);
                        }

                        // Flash-highlight the caret line
                        this.flashCaretLine(view);
                    }
                };

                if (existing) {
                    this.app.workspace.setActiveLeaf(leaf, { focus: true });
                    setTimeout(positionCursor, 50);
                } else {
                    leaf.openFile(file).then(() => {
                        this.app.workspace.setActiveLeaf(leaf, { focus: true });
                        positionCursor();
                    });
                }

                e.preventDefault();
                e.stopPropagation();
            });
        }

        embed.classList.add('elegance-embed-seamless');
    }

    /**
     * Locate the editor and source-text range for an embed DOM element.
     * Returns { editor, from, to, scrollInfo } or null (with a Notice on failure).
     */
    findEmbedInEditor(embedEl, src) {
        const leafEl = embedEl.closest('.workspace-leaf');
        const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.containerEl === leafEl);
        if (!leaf || !(leaf.view instanceof MarkdownView) || !leaf.view.editor) {
            new Notice('No active editor found.');
            return null;
        }
        const editor = leaf.view.editor;
        const sourceContent = editor.getValue();
        const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const embedRegex = new RegExp('!\\[\\[' + escapedSrc + '(\\|[^\\]]*)?\\]\\]');
        const match = sourceContent.match(embedRegex);
        if (!match) {
            new Notice('Could not find embed syntax in source.');
            return null;
        }
        const matchIndex = sourceContent.indexOf(match[0]);
        return {
            editor,
            from: editor.offsetToPos(matchIndex),
            to: editor.offsetToPos(matchIndex + match[0].length),
            scrollInfo: editor.getScrollInfo(),
        };
    }

    /** Shift all markdown headings in `text` so the topmost becomes `targetTopLevel`. */
    shiftHeadingsInText(text, targetTopLevel) {
        const lines = text.split('\n');
        let minLevel = 7;
        for (const line of lines) {
            const m = line.match(/^(#{1,6})\s/);
            if (m && m[1].length < minLevel) minLevel = m[1].length;
        }
        const shift = minLevel < 7 ? targetTopLevel - minLevel : 0;
        if (shift > 0) {
            for (let i = 0; i < lines.length; i++) {
                lines[i] = lines[i].replace(/^(#{1,6})(\s)/, (_, hashes, sp) => {
                    const newLevel = Math.min(hashes.length + shift, 6);
                    return '#'.repeat(newLevel) + sp;
                });
            }
        }
        return lines.join('\n');
    }

    flashCaretLine(view) {
        requestAnimationFrame(() => {
            const cm = view.editor?.cm;
            if (!cm) return;

            const coords = cm.coordsAtPos(cm.state.selection.main.head);
            if (!coords) return;

            const lineH = cm.defaultLineHeight || 22;
            const scroller = cm.scrollDOM.getBoundingClientRect();

            const caretX = ((coords.left - scroller.left) / scroller.width * 100).toFixed(1);

            const bar = document.createElement('div');
            bar.style.cssText =
                'position:fixed;pointer-events:none;z-index:9999;' +
                `left:${scroller.left}px;width:${scroller.width}px;` +
                `top:${coords.top}px;height:${lineH}px;` +
                `background:radial-gradient(25px 100% at ${caretX}% 50%, var(--interactive-accent) 0%, transparent 100%);`;
            document.body.appendChild(bar);

            bar.animate(
                [{ opacity: 0.25 }, { opacity: 0 }],
                { duration: 1200, easing: 'ease-out', fill: 'forwards' }
            ).onfinish = () => bar.remove();
        });
    }

    findContextHeadingLevel(embedEl) {
        const boundary = embedEl.closest('.markdown-embed-content') ||
                         embedEl.closest('.markdown-preview-sizer') ||
                         embedEl.closest('.cm-editor');

        let current = embedEl;

        while (current && current !== boundary) {
            let sibling = current.previousElementSibling;
            while (sibling) {
                const heading = this.findLastOwnHeading(sibling);
                if (heading) return parseInt(heading.tagName[1]);
                sibling = sibling.previousElementSibling;
            }
            current = current.parentElement;
        }

        if (boundary && boundary.classList.contains('markdown-embed-content')) {
            const parentEmbed = boundary.closest('.markdown-embed');
            if (parentEmbed) {
                const parentTitle = parentEmbed.querySelector(':scope > .elegance-embed-title');
                if (parentTitle) {
                    return parseInt(parentTitle.tagName[1]);
                }
            }
        }

        return 1;
    }

    findLastOwnHeading(el) {
        if (/^H[1-6]$/.test(el.tagName)) return el;

        const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
        for (let i = headings.length - 1; i >= 0; i--) {
            const h = headings[i];
            const containingEmbed = h.closest('.markdown-embed');
            if (!containingEmbed || !el.contains(containingEmbed)) {
                return h;
            }
        }

        return null;
    }

    async cementAllEmbeds(file) {
        if (!file) return;

        const leaf = this.app.workspace.getLeavesOfType('markdown')
            .find(l => l.view?.file?.path === file.path);
        if (!leaf || !(leaf.view instanceof MarkdownView) || !leaf.view.editor) {
            new Notice('No active editor found.');
            return;
        }
        const editor = leaf.view.editor;
        let content = editor.getValue();

        // Match all embed syntax: ![[path#section|display]]
        const embedPattern = /!\[\[([^\]]+?)\]\]/g;
        const matches = [...content.matchAll(embedPattern)];
        if (!matches.length) {
            new Notice('No embeds found in this note.');
            return;
        }

        // Build all replacements first, then apply as a single transaction
        const changes = [];
        for (const match of matches) {
            const inner = match[1];
            const src = inner.split('|')[0];
            const linkPath = src.split('#')[0];
            const subpath = src.includes('#') ? src.split('#').slice(1).join('#') : '';

            const target = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
            if (!target || target.extension !== 'md') continue;

            let embeddedContent;
            try {
                embeddedContent = await this.app.vault.cachedRead(target);
            } catch { continue; }

            // Strip frontmatter
            embeddedContent = embeddedContent.replace(/^---\n[\s\S]*?\n---\n?/, '');

            // Extract section if #heading is present
            if (subpath) {
                embeddedContent = this.extractSection(embeddedContent, subpath);
                if (!embeddedContent) continue;
            }

            // Determine heading context from position in document
            const before = content.substring(0, match.index);
            const headingMatches = [...before.matchAll(/^(#{1,6})\s/gm)];
            const contextLevel = headingMatches.length ? headingMatches[headingMatches.length - 1][1].length : 0;
            const titleLevel = Math.min(contextLevel + 1, 6);
            const titleText = subpath || target.basename;
            const titleLine = '#'.repeat(titleLevel) + ' ' + titleText;

            const shifted = this.shiftHeadingsInText(embeddedContent, titleLevel + 1);
            const finalContent = titleLine + '\n' + shifted.trimEnd();
            changes.push({ from: match.index, to: match.index + match[0].length, insert: finalContent });
        }

        if (!changes.length) {
            new Notice('No note embeds could be resolved.');
            return;
        }

        // Dispatch all changes as a single transaction so Ctrl+Z undoes them all at once
        const cm = editor.cm;
        const scrollInfo = editor.getScrollInfo();
        cm.dispatch({ changes });
        requestAnimationFrame(() => editor.scrollTo(scrollInfo.left, scrollInfo.top));

        new Notice(`Cemented ${changes.length} embed${changes.length > 1 ? 's' : ''}.`);
    }

    extractSection(markdown, headingText) {
        const lines = markdown.split('\n');
        let startLine = -1;
        let startLevel = 0;

        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
            if (m && m[2].trim() === headingText) {
                startLine = i;
                startLevel = m[1].length;
                break;
            }
        }

        if (startLine === -1) return null;

        let endLine = lines.length;
        for (let i = startLine + 1; i < lines.length; i++) {
            const m = lines[i].match(/^(#{1,6})\s+/);
            if (m && m[1].length <= startLevel) {
                endLine = i;
                break;
            }
        }

        return lines.slice(startLine, endLine).join('\n');
    }
}

module.exports = ElegancePlugin;
