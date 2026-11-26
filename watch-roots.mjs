// dev server 监听什么 —— 唯一的设计声明。
//
// 背景:热更新(HMR)只和**应用自己的前端源码**有关。改 `js/file-storage.js`,
// 页面局部刷新;库里的音声文件、导入数据、文档、构建产物都和 HMR 无关,监听它们
// 只会烧 CPU/内存,并且在 Windows 上因为「文件被占用不能 watch」(EBUSY)把整个
// dev server 掀掉 —— 上传线程正在读源 wav 时必现。
//
// 所以这里只回答一个问题:**哪些根级目录是浏览器源码。** 其余一律不监听。
// 这不是「本机路径」:目录名是仓库结构的一部分,任何一台机器 clone 下来都一样;
// 判定也在运行时按路径做(见 createWatchIgnore),不依赖启动时枚举的清单。
//
// 新增一个数据目录(语料、备份、下载物)→ 什么都不用改,自动不监听。
// 新增一个**源码**目录 → 必须加进 `BROWSER_SOURCE_DIRS`,否则它的 HMR 不会生效;
// `verify/check.mjs` 的 [6b] 段会在提交时把这种情况拦下来。

/** 会被页面加载、需要 HMR 的目录。 */
export const BROWSER_SOURCE_DIRS = [
    'js', // 应用模块,index.html 加载 js/app.js
    'src', // 样式与少量模块
    'locales', // i18n,由 js/i18n.js import
    'public', // 静态资源,原样服务
    'assets', // 图片/图标
    'images', // 图片
];

/**
 * 明确**不是**浏览器源码的根级目录(带理由)。
 *
 * 运行时并不需要这张表 —— `createWatchIgnore` 只看「在不在 BROWSER_SOURCE_DIRS 里」。
 * 它存在的意义是**文档 + 门禁**:每个根级目录都得能说出为什么不是源码,
 * 说不出来的,大概率该进上面的列表。`verify/check.mjs` [6b] 会核对两表相加
 * 是否覆盖了所有被 git 跟踪的根级目录。
 */
export const NON_BROWSER_DIRS = {
    build: '工作区约定的构建输出与 CD 缓存',
    database: '数据库 schema 参考资料',
    demo: 'Tauri 演示外壳自己的构建树',
    'dev-dist': 'PWA 插件生成的 Service Worker 产物',
    dist: '构建产物',
    docker: '容器部署配置',
    docs: '文档,不参与模块图',
    examples: '示例数据',
    functions: 'Cloudflare Pages Functions,服务端执行',
    'node_modules': '依赖',
    'server': 'Rust storage host,不是前端源码',
    scripts: 'Node 脚本(dev loop、构建辅助)',
    templates: '页面原型模板,运行时不被引用',
    verify: '探针、语料与证据;2.4 GB 音频包就在这里',
};

const toSlashes = (value) => String(value).replaceAll('\\', '/');

/**
 * 生成 `server.watch.ignored` 用的判定函数。
 *
 * 实测 chokidar 只传一个参数:绝对路径字符串(chokidar 的 `_isIgnored` 把
 * `[path, stats]` 交给 anymatch,函数式 matcher 收到的是路径本身)。所以判定
 * 必须只看路径,不依赖 stat。
 *
 * 规则:
 *   - 根之外的路径交给 vite 自己处理;
 *   - `js/` 等源码目录下的任何东西 → 监听;
 *   - 根级单段路径:是源码目录 → 监听;否则(目录或点目录)→ 忽略;
 *   - 根级之下的多段路径:第一段不是源码目录 → 忽略。
 *
 * 最后一条让「运行时才出现的目录」也安全:即使它没在启动时存在,它的子项因为
 * 第一段不是源码目录而被忽略,chokidar 不会递归进去。
 */
export function createWatchIgnore(root) {
    const rootAbs = toSlashes(root).replace(/\/+$/, '') + '/';
    return (candidate) => {
        if (typeof candidate !== 'string') return false;
        const full = toSlashes(candidate);
        if (!full.startsWith(rootAbs)) return false;
        const rel = full.slice(rootAbs.length);
        if (!rel) return false;
        const slash = rel.indexOf('/');
        if (slash < 0) {
            // 根级条目。源码目录保留;已知/未知目录与点目录都排除;
            // 根级文件(index.html、styles.css、vite-plugin-*.js)必须保留 —— 它们
            // 参与 HMR,而目录不参与。
            if (BROWSER_SOURCE_DIRS.includes(rel)) return false;
            return !rel.includes('.');
        }
        return !BROWSER_SOURCE_DIRS.includes(rel.slice(0, slash));
    };
}

/** 根级目录是否已归类(供 `verify/check.mjs` 用)。 */
export function isClassified(name) {
    return BROWSER_SOURCE_DIRS.includes(name) || Object.hasOwn(NON_BROWSER_DIRS, name) || name.startsWith('.');
}
