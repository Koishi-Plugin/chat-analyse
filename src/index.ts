import { Context, Schema, Session, h } from 'koishi';
import { Collector } from './Collector';
import { Stat } from './Stat';
import { WhoAt } from './WhoAt';
import { Data } from './Data';
import { Analyse } from './Analyse';
import { AiAnalyse } from './AiAnalyse';

/** @name 插件使用说明 */
export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`;

export const name = 'chat-analyse';
export const using = ['database', 'puppeteer', 'cron'];

/**
 * @interface Config
 * @description 定义插件的配置项结构。
 */
export interface Config {
  enableListener: boolean;
  enableCmdStat: boolean;
  enableMsgStat: boolean;
  enableRankStat: boolean;
  enableActivity: boolean;
  enableOriRecord: boolean;
  enableWhoAt: boolean;
  enableDataIO: boolean;
  atRetentionDays: number;
  rankRetentionDays: number;
  enableWordCloud: boolean;
  maxWords: number;
  cacheRetentionDays: number;
  enableSimiActivity: boolean;
  enableAutoBackup: boolean;
  color: string;
  shape: string;
  ellipticity: number;
  minRotation: number;
  maxRotation: number;
  rotationSteps: number;
  fontFamily: string;
  maskImage: string;
  excludeWords: string;
  enableAiSummary: boolean;
  tokenPerRequest: number;
  endpoints: {
    url: string;
    key: string;
    model: string;
  }[];
}

/** @description 插件的配置项定义 */
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enableListener: Schema.boolean().default(true).description('启用消息监听'),
    enableDataIO: Schema.boolean().default(true).description('启用数据管理'),
  }).description('杂项配置'),
  Schema.object({
    enableCmdStat: Schema.boolean().default(true).description('启用命令统计'),
    enableMsgStat: Schema.boolean().default(true).description('启用消息统计'),
    enableActivity: Schema.boolean().default(true).description('启用活跃统计'),
    enableSimiActivity: Schema.boolean().default(true).description('启用活跃比较'),
    enableRankStat: Schema.boolean().default(true).description('启用发言排行'),
    enableWhoAt: Schema.boolean().default(true).description('启用提及记录'),
    rankRetentionDays: Schema.number().min(0).default(365).description('排行保留天数'),
    atRetentionDays: Schema.number().min(0).default(3).description('提及保留天数'),
  }).description('基础配置'),
  Schema.object({
    enableOriRecord: Schema.boolean().default(true).description('启用原始记录'),
    enableWordCloud: Schema.boolean().default(true).description('启用词云生成'),
    enableAiSummary: Schema.boolean().default(false).description('启用模型分析'),
    tokenPerRequest: Schema.number().min(100).default(2000).description('每次请求的最大 Token 数'),
    enableAutoBackup: Schema.boolean().default(true).description('启用自动归档'),
    cacheRetentionDays: Schema.number().min(0).default(7).description('记录保留天数'),
    endpoints: Schema.array(Schema.object({
      url: Schema.string().description('端点 (Endpoint)').role('link').required(),
      key: Schema.string().description('密钥 (API Key)').role('secret'),
      model: Schema.string().description('模型 (Model)').required(),
    })).description('模型端点').role('table'),
  }).description('高级配置'),
  Schema.object({
    maxWords: Schema.number().min(0).default(1024).description('最大词量'),
    ellipticity: Schema.number().min(0).max(1).default(1).description('长宽比'),
    rotationSteps: Schema.number().min(0).default(3).description('旋转步数'),
    minRotation: Schema.number().min(-Math.PI).max(Math.PI).default(-Math.PI / 2).description('最小旋转角'),
    maxRotation: Schema.number().min(-Math.PI).max(Math.PI).default(Math.PI / 2).description('最大旋转角'),
    shape: Schema.string().default('square').description('词云形状'),
    color: Schema.string().default('random-light').description('词云颜色'),
    fontFamily: Schema.string().default('"Noto Sans CJK SC", Arial, sans-serif').description('词云字体'),
    maskImage: Schema.string().role('link').description('蒙版图片'),
    excludeWords: Schema.string().role('textarea').default('').description('屏蔽词'),
  }).description('词云配置'),
]);

/**
 * @private @method parseQueryScope
 * @description 解析命令选项，转换为包含 UIDs 和描述性信息的统一查询范围对象。
 * @param session - 当前会话对象。
 * @param options - 命令选项。
 * @returns 包含 uids、错误或范围描述的查询范围对象。
 */
export async function parseQueryScope(ctx: Context, session: Session, options: { user?: string; guild?: string; all?: boolean }): Promise<{ uids?: number[]; error?: string; scopeDesc: { guildId?: string; userId?: string } }> {
    const scopeDesc = { guildId: options.guild, userId: undefined };
    if (options.user) scopeDesc.userId = h.select(options.user, 'at')[0]?.attrs.id ?? options.user.trim();
    if (!options.all && !scopeDesc.guildId && !scopeDesc.userId) scopeDesc.guildId = session.guildId || session.channelId;
    if (!options.all && !scopeDesc.guildId && !scopeDesc.userId) return { error: '请指定查询范围', scopeDesc };

    const query: any = {};
    if (scopeDesc.guildId) query.channelId = scopeDesc.guildId;
    if (scopeDesc.userId) query.userId = scopeDesc.userId;
    if (Object.keys(query).length === 0) return { uids: undefined, scopeDesc };

    const users = await ctx.database.get('analyse_user', query, ['uid']);
    if (users.length === 0) return { error: '暂无统计数据', scopeDesc };

    return { uids: users.map(u => u.uid), scopeDesc };
}

/**
 * @private @method generateTitle
 * @description 根据查询范围和类型动态生成易于理解的图片标题。
 * @returns 生成的标题字符串。
 */
export async function generateTitle(ctx: Context, scopeDesc: { guildId?: string, userId?: string }, options: { main: string; subtype?: string; timeRange?: number; timeUnit?: '小时' | '天' }): Promise<string> {
    let guildName = '', userName = '', scopeText = '全局';

    if (scopeDesc.guildId) {
      const [guild] = await ctx.database.get('analyse_user', { channelId: scopeDesc.guildId }, ['channelName']);
      guildName = guild?.channelName || scopeDesc.guildId;
    }
    if (scopeDesc.userId) {
      const [user] = await ctx.database.get('analyse_user', { userId: scopeDesc.userId }, ['userName']);
      userName = user?.userName || scopeDesc.userId;
    }

    const timeText = options.timeRange ? `${options.timeRange}${options.timeUnit || '小时'}` : '';
    const typeText = options.subtype ? `“${options.subtype}”` : '';
    const mainText = options.main;

    if (mainText.includes('排行') || mainText.includes('活跃')) {
        scopeText = guildName || '全局';
    } else {
        if (userName && guildName) scopeText = `${guildName} ${userName}`;
        else if (userName) scopeText = userName;
        else if (guildName) scopeText = guildName;
    }

    const suffix = mainText.includes('排行') ? '' : '统计';

    return `${timeText}${scopeText}${typeText}${mainText}${suffix}`;
}

/**
 * @function apply
 * @description Koishi 插件的主入口函数，负责初始化和注册所有功能模块。
 * @param ctx - Koishi 的插件上下文。
 * @param config - 用户配置对象。
 */
export function apply(ctx: Context, config: Config) {
  if (config.enableListener) new Collector(ctx, config);

  const analyse = ctx.command('analyse', '数据分析');

  // 动态注册功能模块
  new Stat(ctx, config).registerCommands(analyse);
  if (config.enableWhoAt) new WhoAt(ctx, config).registerCommand(analyse);
  if (config.enableDataIO) new Data(ctx, config).registerCommands(analyse);
  if (config.enableWordCloud || config.enableSimiActivity) new Analyse(ctx, config).registerCommands(analyse);
  if (config.enableAiSummary && config.enableOriRecord) new AiAnalyse(ctx, config).registerCommands(analyse);
}
