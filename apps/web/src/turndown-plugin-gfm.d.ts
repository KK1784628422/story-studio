/** turndown-plugin-gfm 无官方类型声明：gfm 插件（表格/删除线/任务列表）在 DocWorkbench 富文本保存时用于 HTML → Markdown 序列化 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  export function gfm(service: TurndownService): void
  export function tables(service: TurndownService): void
  export function strikethrough(service: TurndownService): void
  export function taskListItems(service: TurndownService): void
}
