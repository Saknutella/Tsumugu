// dev server 监听什么 —— 唯一的设计声明(与主工作区同一套规则)。
//
// 热更新只和应用自己的前端源码有关。库数据、后端源码、构建产物都不参与 HMR;
// 监听它们只会烧 CPU/内存,并在 Windows 上因为文件被占用(EBUSY)把 dev server
// 掀掉 —— dev loop 的 `data/` 正是上传写入的地方,最容易被监听。
//
// 判定在运行时按路径做,所以启动之后才出现的目录也不会被递归监听:语料放哪儿都安全。

/** 会被页面加载、需要 HMR 的目录。 */
export const BROWSER_SOURCE_DIRS = ['js', 'src', 'locales', 'public', 'images'];

/** 明确不是浏览器源码的根级目录(文档 + 门禁用)。 */
export const NON_BROWSER_DIRS = {
    data: 'dev loop 的默认数据根:文件库与源目录,运行时写入',
    database: '数据库 schema 参考资料',
    dist: '构建产物',
    docker: '容器部署配置',
    examples: '示例数据',
    functions: 'Cloudflare Pages Functions,服务端执行',
    node_modules: '依赖',
    scripts: 'Node 脚本(dev loop 等)',
    server: '文件库后端源码(Node 或 Rust),不是前端',
};

const toSlashes = (value) => String(value).replaceAll('\\', '/');

/** 生成 `server.watch.ignored` 的判定函数(chokidar 只传绝对路径字符串)。 */
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
            // 根级条目:源码目录与普通文件保留,其余目录(含点目录)忽略。
            if (BROWSER_SOURCE_DIRS.includes(rel)) return false;
            return !rel.includes('.');
        }
        return !BROWSER_SOURCE_DIRS.includes(rel.slice(0, slash));
    };
}

/** 根级目录是否已归类。 */
export function isClassified(name) {
    return BROWSER_SOURCE_DIRS.includes(name) || Object.hasOwn(NON_BROWSER_DIRS, name) || name.startsWith('.');
}
