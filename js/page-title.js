// 页面标题:自定义内容页优先于播放器当前曲目。
// 之前 updateTabTitle 只看 Player.currentTrack,导致在创作/音声/视频页仍显示上一首歌。
import { t } from './i18n.js';

const PAGE_TITLES = {
    creations: ['creations.title', '创作'],
    voices: ['voices.title', '音声'],
    videos: ['videos.title', '视频'],
    settings: ['settings.title', '设置'],
    'tauri-test': ['tauriTest.title', 'Tauri 测试'],
    about: ['about.title', '关于'],
};

function routePage() {
    return window.location.pathname.replace(/^\/+/, '').split('/')[0] || '';
}

export function applyRouteTitle() {
    const page = routePage();
    const entry = PAGE_TITLES[page];
    if (!entry) return false;
    const translated = t(entry[0]);
    document.title = `${translated === entry[0] ? entry[1] : translated} · Monochrome`;
    return true;
}

export function setTrackDocumentTitle(title, artists) {
    if (applyRouteTitle()) return;
    document.title = `${title} • ${artists}`;
}
