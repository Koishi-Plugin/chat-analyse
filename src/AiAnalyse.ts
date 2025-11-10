import { Context, Command, Time, Session } from 'koishi';
import { Config, parseQueryScope } from './index';

/**
 * @class AiAnalyse
 * @description 提供基于 AI 的聊天记录分析功能。
 */
export class AiAnalyse {
  private endpointIndex = 0;
  private retryTime = 0;

  /**
   * @constructor
   * @param {Context} ctx - Koishi 的上下文对象，用于访问框架服务（如数据库、日志、HTTP 客户端）。
   * @param {Config} config - 插件的配置对象，包含 AI 服务端点、Token 限制等信息。
   */
  constructor(private ctx: Context, private config: Config) {}

  /**
   * 注册 `chatreview` 子命令。
   * @param {Command} cmd - `analyse` 主命令的实例。
   */
  public registerCommands(cmd: Command) {
    cmd.subcommand('chatreview <prompt:text>', '聊天分析')
      .usage('使用模型分析聊天记录，需自行指定分析任务。')
      .option('guild', '-g <guildId:string> 指定群组')
      .option('user', '-u <user:string> 指定用户')
      .option('hours', '-t <hours:number> 指定时长', { fallback: 6 })
      .action(async ({ session, options }, prompt) => {
        if (!prompt) return '请输入分析任务';
        try {
          const recordsText = await this.getFormattedRecords(session, options);
          if (!recordsText) return '暂无聊天记录';
          let processedText = recordsText;
          const tokenLimit = this.config.tokenPerRequest;
          if (Math.ceil(processedText.length / 1.8) > tokenLimit) {
            await session.send('正在处理聊天记录...');
            while (Math.ceil(processedText.length / 1.8) > tokenLimit) {
              const lines = processedText.split('\n');
              const chunks: string[] = [];
              let currentChunkLines: string[] = [];
              let currentTokenCount = 0;
              for (const line of lines) {
                const lineTokenCount = Math.ceil(line.length / 1.8);
                if (currentTokenCount + lineTokenCount > tokenLimit && currentChunkLines.length > 0) {
                  chunks.push(currentChunkLines.join('\n'));
                  currentChunkLines = [];
                  currentTokenCount = 0;
                }
                currentChunkLines.push(line);
                currentTokenCount += lineTokenCount;
              }
              if (currentChunkLines.length > 0) chunks.push(currentChunkLines.join('\n'));

              const condensePromises = chunks.map(chunk => this.requestAi(chunk));
              const condensedChunks = await Promise.all(condensePromises);
              processedText = condensedChunks.join('\n');
            }
          }
          await session.send('正在分析聊天记录...');
          const finalReport = await this.requestAi(processedText, prompt);
          return finalReport;
        } catch (error) {
          this.ctx.logger.error('聊天分析失败:', error);
          return `分析失败: ${error.message}`;
        }
      });
  }

  /**
   * 从数据库获取、格式化并拼接聊天记录。
   * @param {Session} session - 当前的会话对象。
   * @param {any} options - 命令传入的选项，包含时长、用户和群组等过滤条件。
   * @returns {Promise<string | null>} 格式化后的聊天记录字符串，若无记录则返回 null。
   * @throws {Error} 如果查询范围解析失败，则抛出错误。
   */
  private async getFormattedRecords(session: Session, options: any): Promise<string | null> {
    const scope = await parseQueryScope(this.ctx, session, options);
    if (scope.error) throw new Error(scope.error);
    scope.uids ??= (await this.ctx.database.get('analyse_user', { channelId: session.guildId || session.channelId }, ['uid'])).map(u => u.uid);
    if (!scope.uids?.length) return null;
    const since = new Date(Date.now() - options.hours * Time.hour);
    const records = await this.ctx.database.get('analyse_cache', { uid: { $in: scope.uids }, timestamp: { $gte: since } }, { sort: { timestamp: 'asc' } });
    if (!records.length) return null;
    const uniqueUids = [...new Set(records.map(r => r.uid))];
    const users = await this.ctx.database.get('analyse_user', { uid: { $in: uniqueUids } });
    const userInfoMap = new Map(users.map(u => [u.uid, u.userName]));
    const uidToPlaceholderMap = new Map<number, string>();
    const userKeyEntries = uniqueUids.map((uid, index) => {
      const placeholder = String.fromCharCode(65 + index);
      uidToPlaceholderMap.set(uid, placeholder);
      return `${placeholder}:${userInfoMap.get(uid)}`;
    });
    const userKey = `用户:[${userKeyEntries.join(',')}]`;
    const timeRange = `时间:[${records[0].timestamp.toLocaleString('zh-CN', { hour12: false })}-${records[records.length - 1].timestamp.toLocaleString('zh-CN', { hour12: false })}]`;
    const formattedContent = records.map(r => `${uidToPlaceholderMap.get(r.uid)}: ${r.content}`).join('\n');
    return `${timeRange}\n${userKey}\n${formattedContent}`;
  }

  /**
   * 向 AI 服务端点发送请求。
   * @param {string} mainContent - 发送给 AI 的主要内容，即聊天记录或待精简的文本块。
   * @param {string} [task] - 可选的分析任务描述。如果提供，会执行分析任务；如果未提供，则执行精简任务。
   * @returns {Promise<string>} AI 返回的处理结果文本。
   */
  private async requestAi(mainContent: string, task?: string): Promise<string> {
    const systemPrompt = task
      ? `你是一位专业的聊天分析师。你需要基于以下聊天记录和用户信息完成指定任务："${task}"。
用户信息与消息记录的时间在聊天记录之前提供，在聊天记录中用字母表示对应用户，请遵循以下规则：
1. 识别核心: 精准识别关键信息、主要话题、用户观点和情绪倾向。
2. 保持客观: 严格基于聊天记录分析，避免推测或添加不存在的信息。
3. 用用户名: 在分析报告中，必须使用字母对应的用户名来说明用户。
4. 格式要求: 以纯文本进行输出，不要使用任何 Markdown 格式。
5. 字数限制: 将总字数控制在 512 字以内，应紧凑且无空行间隔。
6. 直接回答: 直接呈现分析结果，无需进行额外的对话或开场白。`
      : `你是一位专业的对话摘要师，你需要将以下聊天记录浓缩成一份精简的摘要。请遵循以下规则：
1. 保留核心: 完整保留关键问题、明确的答复、达成的共识、重要的决策和具有强烈情感色彩的表达。
2. 移除冗余: 删除日常问候、无意义的闲聊、重复或口语化的表达，以及离题的对话。
3. 维持结构: 保持原始对话的逻辑顺序和因果关系，让摘要读起来像一个连贯的对话概要。
4. 忠于原文: 不要添加任何外部信息或进行主观解读。输出内容必须完全源于原始记录。
5. 直接输出: 不需要任何额外的解释或开场白，直接提供精简后的内容。`;
    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: mainContent }];
    while (true) {
      try {
        const now = Date.now();
        if (now < this.retryTime) await new Promise(resolve => setTimeout(resolve, this.retryTime - now));
        const endpointConfig = this.config.endpoints[this.endpointIndex];
        const response = await this.ctx.http.post(`${endpointConfig.url.replace(/\/$/, '')}/chat/completions`,
          { model: endpointConfig.model, messages },
          { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${endpointConfig.key}` }, timeout: 600000 }
        );
        const content = response?.choices?.[0]?.message?.content;
        if (content) {
          this.retryTime = 0;
          return content.trim();
        }
        throw new Error(response?.error?.message);
      } catch (error) {
        this.ctx.logger.warn('请求失败:', error);
        this.endpointIndex = (this.endpointIndex + 1) % this.config.endpoints.length;
        this.retryTime = Date.now() + 30000;
      }
    }
  }
}
