// 共享的导入选项条。
//
// 三个数据源共用同一套存储/渲染/变更逻辑,但每个源只声明自己真正适用的选项:
//   · 创作:导入时是否自动保存图片(缩略图 + 原图)到本地、同 URL 重导是否覆盖本地附件;
//   · 音声/视频:只保存元数据,没有本地文件,所以只有"重导是否覆盖记录"。
// 这样不会为了看起来一致而摆一个永远无效的"删除本地文件"开关。
import { t } from './i18n.js';

function readStorage(storageKey, legacyKeys) {
    for (const key of [storageKey, ...(legacyKeys || [])]) {
        try {
            const value = JSON.parse(localStorage.getItem(key) || 'null');
            if (value && typeof value === 'object') return value;
        } catch {
            // 忽略损坏的旧值,继续尝试下一个 key。
        }
    }
    return null;
}

export function createImportOptions({
    storageKey,
    container,
    labelKey = 'importOptions.label',
    items,
    defaults = {},
    noteKey = '',
    legacyKeys = [],
}) {
    const values = { ...defaults };
    const stored = readStorage(storageKey, legacyKeys);
    if (stored) {
        for (const item of items) {
            if (item.id in stored) values[item.id] = Boolean(stored[item.id]);
        }
    }

    const root = typeof container === 'string' ? document.querySelector(container) : container;
    if (!root) return { values, get: (id) => values[id], set: () => {} };

    root.innerHTML = `
        <span class="creations-import-options-label">${t(labelKey)}</span>
        ${items
            .map(
                (item) => `<label title="${item.titleKey ? t(item.titleKey) : ''}">
                    <input type="checkbox" id="${item.elementId || `import-option-${item.id}`}" data-import-option="${item.id}" ${values[item.id] ? 'checked' : ''} />
                    <span>${t(item.labelKey)}</span>
                </label>`,
            )
            .join('')}
        ${noteKey ? `<span class="import-options-note">${t(noteKey)}</span>` : ''}`;

    const persist = () => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(values));
        } catch (error) {
            console.error(`Failed to persist import options (${storageKey}):`, error);
        }
    };

    root.querySelectorAll('[data-import-option]').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
            values[checkbox.dataset.importOption] = checkbox.checked;
            persist();
        });
    });

    return {
        values,
        get: (id) => values[id],
        set: (id, value) => {
            values[id] = Boolean(value);
            const checkbox = root.querySelector(`[data-import-option="${id}"]`);
            if (checkbox) checkbox.checked = values[id];
            persist();
        },
    };
}
