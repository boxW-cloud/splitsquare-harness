function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function page(title: string, heading: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0f16; color: #e7edf7; }
    main { width: min(720px, calc(100vw - 48px)); padding: 42px; border: 1px solid #253148; border-radius: 18px; background: #111827; box-shadow: 0 24px 80px #0008; }
    h1 { margin: 0 0 14px; font-size: 24px; font-weight: 650; }
    p { color: #a9b6ca; line-height: 1.7; }
    .pulse { width: 34px; height: 34px; margin-bottom: 24px; border: 3px solid #26334a; border-top-color: #5e8cff; border-radius: 50%; animation: spin .9s linear infinite; }
    pre { max-height: 300px; overflow: auto; padding: 16px; border-radius: 10px; background: #080b11; color: #c7d2e5; white-space: pre-wrap; word-break: break-word; font: 12px/1.55 Consolas, monospace; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body><main>${body}<h1>${escapeHtml(heading)}</h1></main></body>
</html>`
}

export function startupPage(workspace: string): string {
  return page(
    '正在启动 SplitSquare Harness',
    '正在启动 SplitSquare Harness…',
    `<div class="pulse"></div><p>正在加载模型、会话和工具插件。</p><p>默认工作目录：${escapeHtml(workspace)}</p>`,
  )
}

export function errorPage(message: string, logs: readonly string[]): string {
  const details = logs.length === 0 ? '' : `<pre>${escapeHtml(logs.slice(-40).join('\n'))}</pre>`
  return page(
    'SplitSquare Harness 启动失败',
    'Harness 后端未能启动',
    `<p>${escapeHtml(message)}</p><p>可从“Harness”菜单选择“重新启动后端”。</p>${details}`,
  )
}

export function toDataUrl(html: string): string {
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`
}
