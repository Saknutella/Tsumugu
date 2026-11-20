// 共享的加载/错误/空态文本层。
//
// 只负责"同一个状态容器在三种状态下的文本与视觉",不接管具体数据请求;
// 音声/视频导入先接入,后续创作页的导入状态也可以直接复用。
export function setUiState(element, state, message = '') {
    if (!element) return;
    element.hidden = !message;
    if (message) element.textContent = message;
    element.dataset.state = state;
    element.setAttribute('role', state === 'error' ? 'alert' : 'status');
    element.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');
}
