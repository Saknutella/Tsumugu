// 社团(circle)与译者(translator)的身份分离。
//
// asmr.one / Kikoeru 的 `circle` 字段有时装的是「みんなで翻訳」的译者名
// （例如 漁貓 是 RJ01682626 繁体版的译者，原社团是 ゆきんこ王国）。一旦把译者
// 当社团，侧车元数据(user_meta / metadata.json)与筛选 facet 都会冒出错误的
// 社团名，而 `trueCircle` 才是原作社团。规则只写在这一个模块里，由
// file-storage.js 与 voices.js 共用：分散到三处各写一半，迟早只会改到其中一处。

/** 译者名单：非数组时视为空，并去掉空值与多余空白，便于直接做名字比较。 */
export function voiceTranslatorList(work) {
    return Array.isArray(work?.translators)
        ? work.translators.map((name) => String(name || '').trim()).filter(Boolean)
        : [];
}

function circleText(value) {
    return String(value || '').trim();
}

/**
 * 写进侧车 / 数据库的社团。
 *
 * 有 `trueCircle` 就用它；否则只要存在译者，`circle` 就不可信（asmr.one 把
 * 译者塞在这里），宁可为空，也不要把译者名当成社团发出去。
 */
export function voicePublishedCircle(work) {
    const trueCircle = circleText(work?.trueCircle);
    if (trueCircle) return trueCircle;
    return voiceTranslatorList(work).length ? '' : circleText(work?.circle);
}

/**
 * 卡片显示 / 筛选 facet 用的社团。
 *
 * `trueCircle` 优先；没有它时，只有「这条是翻译版（code 与 sourceCode 不同）
 * 且 circle 正好是译者名」才丢弃 circle —— 原作版的 circle 是可信的，不能
 * 因为有译者名单就一起清空。
 */
export function voiceDisplayCircle(work) {
    const trueCircle = circleText(work?.trueCircle);
    if (trueCircle) return trueCircle;
    const circle = circleText(work?.circle);
    if (!circle) return '';
    const code = circleText(work?.code).toUpperCase();
    const sourceCode = circleText(work?.sourceCode).toUpperCase();
    const translated = Boolean(code && sourceCode && code !== sourceCode);
    if (translated && voiceTranslatorList(work).includes(circle)) return '';
    return circle;
}
