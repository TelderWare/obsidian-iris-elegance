'use strict';

const { PluginSettingTab, Setting, setIcon } = require('obsidian');
const { IconPickerModal, CommandPickerModal } = require('./modals');

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
    hiddenStatusBarItems: [],
    customWordCount: true,
    wcIncludeHeadings: false,
    wcIncludeCodeBlocks: false,
    wcIncludeFrontmatter: false,
    wcIncludeComments: false,
    wcIncludeBlockQuotes: false,
    wcIncludeFootnotes: false,
    wcIncludeCitations: false,
    wcIncludeTables: false,
    wcIncludeMath: false,
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

        new Setting(containerEl)
            .setName('Custom word count')
            .setDesc('Replace the vanilla word count item with one that shows only words. Click the item in the status bar to toggle what is counted.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.customWordCount)
                .onChange(async (value) => {
                    this.plugin.settings.customWordCount = value;
                    await this.plugin.saveSettings();
                    this.plugin.applyCustomWordCount();
                    this.display();
                }));

        if (this.plugin.settings.customWordCount && this.plugin.isVanillaWordCountEnabled()) {
            new Setting(containerEl)
                .setName('Vanilla word count is still running')
                .setDesc('Obsidian’s built-in Word count core plugin is still enabled, so both counters are running side by side. Disable it for the performance benefit.')
                .addButton(btn => btn
                    .setButtonText('Disable vanilla word count')
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.disableVanillaWordCount();
                        this.display();
                    }));
        }

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

module.exports = { DEFAULT_SETTINGS, EleganceSettingTab };
