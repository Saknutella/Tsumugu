// asmr.one 智能初始路径(纯函数,无 DOM)。
//
// 算法来自 asmr.one bundle 的 WorkTree.getInitialPath(见 docs/handoff/59 §2.3):
//   · 单链文件夹一路下钻;
//   · 按文件夹聚合音频 duration / 扩展名计数 / SE 标记;
//   · 过滤 おまけ/特典/附赠/杂谈/freetalk;
//   · 候选 >6 个就放弃自动路径;
//   · 先按 audioTypePreference 选用户首选格式;同格式内按时长选主内容;
//   · 多个 part 时展开格式目录 + 源顺序第一个 part;SE 偏好用于同格式内部。
//
// 与上游的两处小改进(有测试锁定):
//   · 过滤词统一小写,避免 "FreeTalk" 漏过滤;
//   · duration 缺失按 0 处理,全部为 0 时直接回退单链,不让 NaN 排序。

export const DEFAULT_AUDIO_TYPE_PREFERENCE = Object.freeze([
    'mp3',
    'flac',
    'wav',
    'opus',
    'm4a',
    'aac',
]);

export const BONUS_WORDS = Object.freeze(['おまけ', '特典', '附赠', '杂谈', 'freetalk']);

const SE_NEGATIVE = Object.freeze(['no', 'cut', '无', '無', 'なし', 'less', 'カット']);
const SE_MARKERS = Object.freeze(['se', '效果音', '音效', '効果音']);

export function getVoiceNodeExtension(node) {
    const title = String(node?.title || '');
    const index = title.lastIndexOf('.');
    if (index < 0) return '';
    const extension = title.slice(index + 1).toLowerCase();
    return extension && extension !== title.toLowerCase() ? extension : '';
}

export function hasNoSeMarker(value) {
    const text = String(value || '').toLowerCase();
    return SE_NEGATIVE.some((negative) => SE_MARKERS.some((marker) => text.includes(negative) && text.includes(marker)));
}

export function hasSeMarker(value) {
    return !hasNoSeMarker(value);
}

export function folderPathKey(path) {
    return JSON.stringify(path || []);
}

export function expandPathPrefixes(path) {
    const list = Array.isArray(path) ? path : [];
    return list.map((_, index) => folderPathKey(list.slice(0, index + 1)));
}

export function isFolderOnPath(folderPath, initialPath) {
    const folder = Array.isArray(folderPath) ? folderPath : [];
    const target = Array.isArray(initialPath) ? initialPath : [];
    if (folder.length > target.length) return false;
    return folder.every((title, index) => title === target[index]);
}

function normalizeTypes(value) {
    const source = Array.isArray(value) && value.length ? value : DEFAULT_AUDIO_TYPE_PREFERENCE;
    return source.map((item) => String(item || '').toLowerCase()).filter(Boolean);
}

function collectGroups(nodes, basePath, groups) {
    for (const node of nodes || []) {
        if (!node) continue;
        if (node.type === 'folder') {
            collectGroups(node.children, [...basePath, node.title], groups);
        } else if (node.type === 'audio') {
            const key = basePath.join('/');
            let group = groups.find((entry) => entry.path.join('/') === key);
            if (!group) {
                const lowerKey = key.toLowerCase();
                if (BONUS_WORDS.some((word) => lowerKey.includes(word.toLowerCase()))) continue;
                group = {
                    path: [...basePath],
                    duration: 0,
                    extensions: Object.create(null),
                    se: hasSeMarker(key),
                };
                groups.push(group);
            }
            const duration = Number(node.duration);
            group.duration += Number.isFinite(duration) && duration > 0 ? duration : 0;
            const extension = getVoiceNodeExtension(node);
            if (extension) group.extensions[extension] = (group.extensions[extension] || 0) + 1;
        }
    }
}

function commonPathPrefix(paths) {
    const lists = (paths || []).filter((path) => Array.isArray(path));
    if (lists.length === 0) return [];
    let prefix = [...lists[0]];
    for (const path of lists.slice(1)) {
        let index = 0;
        while (index < prefix.length && index < path.length && prefix[index] === path[index]) index += 1;
        prefix = prefix.slice(0, index);
        if (prefix.length === 0) break;
    }
    return prefix;
}

function isAudioTypeFolderName(name) {
    const lower = String(name || '').toLowerCase();
    return DEFAULT_AUDIO_TYPE_PREFERENCE.some((type) => lower.includes(type));
}

export function getVoiceInitialPath(tracks, options = {}) {
    const behavior = options.initialPathBehavior === 'root' ? 'root' : 'auto';
    const sePreference = options.sePreference !== false;
    const audioTypePreference = normalizeTypes(options.audioTypePreference);
    const prefix = [];
    let rest = Array.isArray(tracks) ? tracks : [];

    while (rest.length === 1 && rest[0]?.type === 'folder') {
        if (!rest[0].title) break;
        prefix.push(rest[0].title);
        if (!Array.isArray(rest[0].children) || rest[0].children.length === 0) break;
        rest = rest[0].children;
    }

    if (behavior !== 'auto' || !Array.isArray(tracks) || tracks.length === 0) return prefix;

    const groups = [];
    collectGroups(rest, prefix, groups);
    if (groups.length === 0) return prefix;

    const totalDuration = groups.reduce((sum, group) => sum + group.duration, 0);
    if (totalDuration <= 0) {
        // File-storage imports have no probed per-track duration yet. Still honor
        // the user's mp3-first preference when the tree has explicit format folders.
        if (options.localFileTree) {
            const typedGroups = groups.filter((group) =>
                group.path.some((part) => isAudioTypeFolderName(part)),
            );
            for (const type of audioTypePreference) {
                const match = typedGroups.find((group) => group.path.some((part) => String(part).toLowerCase().includes(type)));
                if (match) return match.path;
            }
        }
        return prefix;
    }

    // 类型优先：用户把 mp3 放第一位，就应该先看 mp3 目录，而不是被“最长
    // 的 wav 目录”用时长门槛挡掉。类型内部再按时长选主内容；超过 6 个
    // 同级 part 时由下面的公共父级逻辑只展开格式目录 + 第一个 part。
    let preferred = groups;
    for (const type of audioTypePreference) {
        const matching = groups.filter((group) => (group.extensions[type] || 0) > 0);
        if (matching.length > 0) {
            preferred = matching;
            break;
        }
    }

    if (preferred.length > 6) {
        const common = commonPathPrefix(preferred.map((group) => group.path));
        if (!common.length) return prefix;
        const sourceOrdered = [...preferred].sort((a, b) => groups.indexOf(a) - groups.indexOf(b));
        const first = sourceOrdered.find((group) => group.path.length > common.length);
        return first?.path ?? common;
    }

    const seMatched = preferred.filter((group) => group.se === sePreference);
    const candidates = seMatched.length ? seMatched : preferred;

    const ordered = [...candidates].sort(
        (a, b) => b.duration - a.duration || Object.values(b.extensions).reduce((x, y) => x + y, 0) - Object.values(a.extensions).reduce((x, y) => x + y, 0)
    );

    let chosen = ordered[0] || candidates[0] || groups[0];
    // 选中的是「格式目录/某个 part」时，固定展开源顺序第一个 part，其余折叠；
    // 直挂音频的格式目录（如 本編mp3）没有这一层，保持自身。
    const parent = chosen.path.slice(0, -1);
    if (parent.length && isAudioTypeFolderName(parent[parent.length - 1])) {
        const parentKey = parent.join('\u0000');
        const siblings = groups.filter((group) =>
            group.path.length === chosen.path.length &&
            group.path.slice(0, -1).join('\u0000') === parentKey
        );
        if (siblings.length > 1) {
            const first = [...siblings].sort((a, b) => groups.indexOf(a) - groups.indexOf(b))[0];
            if (first) chosen = first;
        }
    }
    return chosen?.path ?? prefix;
}
