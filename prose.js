'use strict';

const { ViewPlugin, Decoration, WidgetType, EditorView, keymap } = require('@codemirror/view');
const { StateField, StateEffect, Prec } = require('@codemirror/state');
const { syntaxTree } = require('@codemirror/language');

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

module.exports = {
    setProseMode,
    proseModeField,
    proseBlockField,
    proseViewPlugin,
    proseBlockAtomic,
    proseKeymap,
};
