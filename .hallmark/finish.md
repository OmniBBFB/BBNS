# Hallmark polish 验证记录

2026-10-26，editorial / app scope。

- sloplint 静态和渲染：0 FAIL、0 REFLEX、0 WARN；44 次命中均属于一个已豁免规则 49b。文章标题为来源原文，手机换行优于裁剪或横向溢出。
- 原审查：84 FAIL、70 REFLEX、6 WARN；原审查因缺少 puppeteer-core 未生成修改前截图，不提供虚构的前后截图对比。
- kept：静态记录中的链接 2/2 保留；动态交互另用浏览器回归验证。
- node --test：39/39 通过。
- tools/check-reader-polish.mjs：URL恢复、刷新、来源/搜索、清除、键盘焦点、16px正文、44px输入与刷新按钮、320/375/414/1280/1920px无整页溢出、空归档与HTTP错误状态通过，无脚本异常。
- 浏览器依赖装在 /tmp/bbns-hallmark-tools，不变更项目依赖。复现：HALLMARK_PUPPETEER=/tmp/bbns-hallmark-tools node tools/check-reader-polish.mjs。

## Finish review：in-thread

ship。桌面和手机首屏已目视检查；本轮按polish范围保留归档侧栏和手机日期横向轨道。阅读字号和按钮密度一致，日期、筛选、搜索、正文层级清晰；未引入新的装饰性内容。未获得修改前渲染图，无法声称完成视觉前后对比。应保留来源、原文标题和正文阅读尺度。

## 文案与装饰变更

- “阅读档案 ARCHIVE” → “阅读档案”。
- “每一天，都有记录。/ 从今天出发，回看值得关注的事。” → “按日期回看已生成的资讯简报。”
- “DAILY BRIEFING” 初始占位 → 加载后显示真实日期 time。
- 移除 THE DAILY BRIEF. 装饰章、状态装饰点、来源装饰点和链接尾箭头；保留全部原文标题、摘要和URL。
- 搜索新增可见标签“搜索资讯”，占位提示“标题、摘要或来源”。
- 元数据分隔改为空间或斜线。日报为空与筛选无结果分别提供对应提示。

没有图片占位，不需要补充视觉素材。
