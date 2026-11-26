// 全局返回顶部。
//
// 这个模块原本还负责像素级内容宽度拖拽（`#content-resizer`）。2026-11-08 的
// `experiment: use auto-width library layout`（d0aa2120，交接 73）把宽度交给 CSS 与
// auto-fill 网格，拖杆先被隐藏；2026-11-27 交接 360 把探针改成自动布局断言之后，
// 拖拽代码成了彻底跑不到的死代码（`AUTO_LAYOUT = true` 常量化，`#content-resizer`
// 又被 CSS `display:none!important` 永久隐藏），于是整块删除：DOM 里的元素、
// `.content-resizer` 样式、`body.is-resizing-content`、`--content-max-width` 变量、
// 以及 `FRAMES` 登记表都不再存在。
//
// 为什么不留着「便于回滚」：回滚需要同时恢复 HTML、CSS、JS 三处，而留下的死代码
// 会持续误导后来者（三轮交接都在讨论它）。真需要时从 `git show d0aa2120^` 取回
// 那份实现更快，也比维护一份永不执行的副本更不容易出错。
//
// 宽度现在是纯 CSS 的：库页 `width:100%; max-width:none`，创作详情
// `max-width:min(1120px,100%)`（正文行长不能失控）。

const BACK_TO_TOP_THRESHOLD = 300;

export function initializeLayoutControls() {
    const main = document.querySelector('.main-content');
    const backToTop = document.getElementById('back-to-top');
    if (!main || !backToTop) return;

    function updateBackToTop() {
        const scrolled = main.scrollTop > BACK_TO_TOP_THRESHOLD || window.scrollY > BACK_TO_TOP_THRESHOLD;
        backToTop.classList.toggle('is-visible', scrolled);
        backToTop.setAttribute('aria-hidden', String(!scrolled));
        backToTop.tabIndex = scrolled ? 0 : -1;
    }

    backToTop.addEventListener('click', () => {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const behavior = reduceMotion ? 'auto' : 'smooth';
        if (main.scrollHeight > main.clientHeight + 4 && main.scrollTop > 0) {
            main.scrollTo({ top: 0, behavior });
        } else {
            window.scrollTo({ top: 0, behavior });
        }
    });

    main.addEventListener('scroll', updateBackToTop, { passive: true });
    window.addEventListener('scroll', updateBackToTop, { passive: true });
    window.addEventListener('resize', updateBackToTop);

    updateBackToTop();
}
