'use strict';

const { SuggestModal, getIconIds, getIcon } = require('obsidian');

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

module.exports = { IconPickerModal, CommandPickerModal };
