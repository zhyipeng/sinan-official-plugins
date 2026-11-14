export function pasteFailureMessage(message,platform){
 const hint=/mac/i.test(platform)?'请开启司南的辅助功能权限，或点复制手动粘贴。':/win/i.test(platform)?'请确认原应用仍在运行；高权限窗口可能需要手动粘贴。':'自动粘贴需要 X11 与 xdotool；Wayland 请点复制后手动粘贴。';
 return `${message}；${hint}`;
}
