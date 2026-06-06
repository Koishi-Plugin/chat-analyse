import { Context, Time } from 'koishi';
import {} from 'koishi-plugin-puppeteer';
import { WordCloudData } from './Analyse';
import { wordCloudScript } from './wordcloud';
import { Config } from './index';

/**
 * @interface ListRenderData
 * @description 定义了调用 `renderList` 方法所需的数据结构。
 */
export interface ListRenderData {
  title: string;
  time: Date;
  total?: string | number;
  list: (string | number | Date)[][];
}

/**
 * @interface LineChartData
 * @description 定义了调用 `renderLineChart` 方法所需的数据结构，支持多组数据系列。
 */
export interface LineChartData {
  title: string;
  time: Date;
  series: {
    name: string;
    data: number[];
  }[];
  labels: string[];
}

/**
 * @class Renderer
 * @description 负责将结构化的数据渲染为设计精美的 PNG 图片。
 */
export class Renderer {
  private readonly COMMON_STYLE = `
    :root {
      --card-bg: #fff; --text-color: #111827; --header-color: #111827;
      --sub-text-color: #6b7280; --border-color: #e5e7eb; --accent-color: #4a6ee0;
      --chip-bg: #f3f4f6; --stripe-bg: #f9fafb; --gold: #f59e0b;
      --silver: #9ca3af; --bronze: #a16207;
    }
    body {
      display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
      Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: transparent; margin: 0; padding: 8px;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      display: inline-block; background: var(--card-bg); border-radius: 12px;
      padding: 0; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,.05);
      min-width: 480px; max-width: 640px;
    }
    .header {
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
    }
    .title-text {
      font-size: 16px; font-weight: 600; color: var(--header-color);
      margin: 0 8px; text-align: center;
    }
    .stat-chip, .time-label {
      display: inline-flex; align-items: baseline; padding: 4px 8px;
      border-radius: 8px; background: var(--chip-bg);
      font-size: 13px; color: var(--sub-text-color);
      white-space: nowrap;
    }
    .stat-chip span {
      font-weight: 600; color: var(--text-color); margin-left: 4px;
    }
  `;

  /**
   * @constructor
   * @description Renderer 类的构造函数。
   * @param {Context} ctx - Koishi 的插件上下文，用于访问 logger 和 puppeteer 服务。
   */
  constructor(private ctx: Context) {}

  /**
   * @private
   * @method generateFullHtml
   * @description 将卡片内容和特定样式组合成一个完整的 HTML 文档，以便进行渲染。
   * @param {string} cardContent - 卡片主体部分的 HTML 字符串。
   * @param {string} specificStyles - 针对该卡片类型的特定 CSS 样式字符串。
   * @returns {string} - 一个完整的、可被浏览器渲染的 HTML 字符串。
   */
  private generateFullHtml(cardContent: string, specificStyles: string): string {
    return `<!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <style>${this.COMMON_STYLE}${specificStyles}</style>
        </head>
        <body>
          ${cardContent}
        </body>
      </html>`;
  }

  /**
   * @private
   * @method htmlToImage
   * @description 使用 puppeteer 将给定的 HTML 字符串内容渲染成 PNG 图片的 Buffer。
   * @param {string} fullHtmlContent - 完整的 HTML 内容字符串。
   * @returns {Promise<Buffer | null>} - 成功时返回包含 PNG 图片数据的 Buffer，失败则返回 null。
   */
  private async htmlToImage(fullHtmlContent: string): Promise<Buffer | null> {
    const page = await this.ctx.puppeteer.page();
    try {
      await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1.0 });
      await page.setContent(fullHtmlContent, { waitUntil: 'networkidle0' });
      const { width, height } = await page.evaluate(() => ({
          width: document.body.scrollWidth,
          height: document.body.scrollHeight
      }));
      await page.setViewport({ width, height, deviceScaleFactor: 1.0 });
      return await page.screenshot({ type: 'png', omitBackground: true });
    } catch (error) {
      this.ctx.logger.error('图片渲染失败:', error);
      return null;
    } finally {
      if (page && !page.isClosed()) await page.close()
    }
  }

  /**
   * @private
   * @method formatDate
   * @description 将 Date 对象格式化为易于理解的相对时间字符串（如“刚刚”，“5分钟前”）。
   * @param {Date} date - 需要格式化的日期对象。
   * @returns {string} - 格式化后的时间字符串。
   */
  private formatDate(date: Date): string {
    if (!date) return '未知';
    const diff = Date.now() - date.getTime();
    if (diff < Time.minute) return '刚刚';
    if (diff > 365 * Time.day) return date.toLocaleDateString('zh-CN');

    const units: [string, number][] = [['月', 30 * Time.day], ['天', Time.day], ['小时', Time.hour], ['分钟', Time.minute]];
    for (const [unit, ms] of units) {
      if (diff >= ms) return `${Math.floor(diff / ms)}${unit}前`;
    }
    return '刚刚';
  }

  /**
   * @public
   * @method renderList
   * @description 将表格型数据渲染成列表形式的图片。如果数据过多，会通过异步生成器逐个产出图片。
   * @param {ListRenderData} data - 包含标题、时间、总计和列表数据的对象。
   * @param {string[]} [headers] - （可选）列表的表头数组。
   * @returns {AsyncGenerator<Buffer>} - 一个异步生成器，每次迭代产出一张图片的 Buffer。
   */
  public async *renderList(data: ListRenderData, headers?: string[]): AsyncGenerator<Buffer> {
    const { title, time, list } = data;
    const CHUNK_SIZE = 200;
    const totalItems = list.length;
    const countHeaderIndex = headers?.findIndex(h => ['总计发言', '条数', '次数', '数量'].includes(h)) ?? -1;
    const totalCount = data.total || (countHeaderIndex > -1 ? list.reduce((sum, row) => sum + (Number(row[countHeaderIndex]) || 0), 0) : totalItems);

    const renderCell = (cell: any, i: number) => {
      const headerText = headers?.[i] || '';
      if (headerText.includes('占比')) {
        return `<td class="percent-cell"><div class="percent-bar" style="width: ${String(cell)};"></div><span class="percent-text">${cell}</span></td>`;
      }
      if (cell instanceof Date) return `<td class="date-cell">${this.formatDate(cell)}</td>`;
      if (typeof cell === 'number') return `<td class="count-cell">${cell.toLocaleString()}</td>`;
      return `<td class="name-cell">${String(cell)}</td>`;
    };

    const listStyles = `
      .table-container { padding: 0; }
      .main-table { border-collapse: collapse; width: 100%; }
      .main-table th, .main-table td { padding: 9px 16px; vertical-align: middle; text-align: left; }
      .main-table thead { border-bottom: 1px solid var(--border-color); }
      .main-table th { font-size: 12px; font-weight: 500; color: var(--sub-text-color); text-transform: uppercase; white-space: nowrap; }
      .main-table td { font-size: 14px; color: var(--text-color); }
      .main-table tbody tr:nth-child(even) { background-color: var(--stripe-bg); }
      .rank-cell, .count-cell, .date-cell, .percent-cell { text-align: right; white-space: nowrap; width: 1%; font-variant-numeric: tabular-nums; }
      .name-cell { font-weight: 500; }
      .rank-cell { font-weight: 600; color: var(--sub-text-color); }
      .count-cell { font-weight: 600; color: var(--accent-color); }
      .rank-gold, .rank-silver, .rank-bronze { font-weight: 700; }
      .rank-gold { color: var(--gold) !important; }
      .rank-silver { color: var(--silver) !important; }
      .rank-bronze { color: var(--bronze) !important; }
      .percent-cell { position: relative; padding-right: 20px; }
      .percent-bar { position: absolute; top: 50%; right: 0; transform: translateY(-50%); height: 6px; background-color: var(--accent-color); opacity: .2; border-radius: 3px; }
      .percent-text { position: relative; z-index: 1; }
    `;

    for (let i = 0; i < totalItems; i += CHUNK_SIZE) {
      const chunk = list.slice(i, i + CHUNK_SIZE);
      const pageNum = Math.floor(i / CHUNK_SIZE) + 1;
      const pageTitle = totalItems > CHUNK_SIZE ? `${title} (第 ${pageNum}/${Math.ceil(totalItems / CHUNK_SIZE)} 页)` : title;

      const cardHtml = `
        <div class="container">
          <div class="header">
            <div class="stat-chip">总计: <span>${typeof totalCount === 'number' ? totalCount.toLocaleString() : totalCount}</span></div>
            <h1 class="title-text">${pageTitle}</h1>
            <div class="time-label">${time.toLocaleString('zh-CN', { hour12: false })}</div>
          </div>
          <div class="table-container">
            <table class="main-table">
              ${headers?.length ? `
                <thead>
                  <tr>
                    <th class="rank-cell">#</th>
                    ${headers.map(h => `<th>${h}</th>`).join('')}
                  </tr>
                </thead>` : ''
              }
              <tbody>
                ${chunk.map((row, index) => {
                  const rank = i + index + 1;
                  const rankClass = rank === 1 ? 'rank-gold' : rank === 2 ? 'rank-silver' : rank === 3 ? 'rank-bronze' : '';
                  return `<tr><td class="rank-cell ${rankClass}">${rank}</td>${row.map(renderCell).join('')}</tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>`;

      const fullHtml = this.generateFullHtml(cardHtml, listStyles);
      const imageBuffer = await this.htmlToImage(fullHtml);
      if (imageBuffer) yield imageBuffer;
    }
  }

  /**
   * @public
   * @method renderLineChart
   * @description 将时间序列数据（如活跃度）渲染成一张基于 SVG 的折线图。支持单组或多组数据进行对比。
   * @param {LineChartData} data - 包含标题、时间、数据系列和标签的对象。
   * @returns {AsyncGenerator<Buffer>} - 一个异步生成器，产出渲染后的图片 Buffer。
   */
  public async *renderLineChart(data: LineChartData): AsyncGenerator<Buffer> {
    const { title, time, series, labels } = data;
    const seriesColors = series.map(() => {
      const hue = Math.floor(Math.random() * 360);
      const saturation = Math.floor(Math.random() * 30 + 70);
      const lightness = Math.floor(Math.random() * 20 + 50);
      return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    });

    const maxVal = Math.max(1, ...series.flatMap(s => s.data));
    const yTickCount = 5;
    const yTickValue = Math.ceil(maxVal / yTickCount);
    const yAxisMax = yTickValue * yTickCount;

    const getX = (index: number) => {
      if (labels.length <= 1) return 320;
      return 40 + (index / (labels.length - 1)) * 540;
    };
    const getY = (value: number) => 250 - (value / yAxisMax) * 240;

    let svgElements = '';

    for (let i = 0; i <= yTickCount; i++) {
        const y = getY(i * yTickValue);
        const value = i * yTickValue;
        svgElements += `<line x1="40" y1="${y}" x2="580" y2="${y}" stroke="var(--border-color)" stroke-width="1"/>`;
        svgElements += `<text x="32" y="${y + 4}" font-size="10" fill="var(--sub-text-color)" text-anchor="end">${value}</text>`;
    }

    labels.forEach((label, index) => {
        if (labels.length > 1 && index % Math.ceil(labels.length / 12) === 0) {
            const x = getX(index);
            svgElements += `<text x="${x}" y="270" font-size="10" fill="var(--sub-text-color)" text-anchor="middle">${label}</text>`;
        }
    });

    series.forEach((s, seriesIndex) => {
        const color = seriesColors[seriesIndex % seriesColors.length];
        const points = s.data.map((value, index) => `${getX(index)},${getY(value)}`).join(' ');
        svgElements += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>`;
    });

    const chartAreaHeight = 280;
    const legendMargin = 20;
    let legendBlockHeight = 0;

    if (series.length > 1) {
      const legendRows = Math.ceil(series.length / 3);
      const legendRowHeight = 15;
      legendBlockHeight = legendRows * legendRowHeight;

      const LEGEND_START_Y = chartAreaHeight + legendMargin;
      const columnWidth = 560 / 3;
      series.forEach((s, seriesIndex) => {
        const rowIndex = Math.floor(seriesIndex / 3);
        const colIndex = seriesIndex % 3;
        const legendX = 40 + (colIndex * columnWidth);
        const legendY = LEGEND_START_Y + (rowIndex * legendRowHeight);
        const color = seriesColors[seriesIndex % seriesColors.length];
        svgElements += `<rect x="${legendX}" y="${legendY - 8}" width="12" height="8" fill="${color}" rx="2"/>`;
        svgElements += `<text x="${legendX + 18}" y="${legendY}" font-size="12" fill="var(--text-color)">${s.name}</text>`;
      });
    }

    const totalLegendSpace = legendBlockHeight > 0 ? legendMargin + legendBlockHeight : 0;
    const svgHeight = chartAreaHeight + totalLegendSpace;
    const totalMessages = series.reduce((sum, s) => sum + s.data.reduce((a, b) => a + b, 0), 0);
    const cardHtml = `
      <div class="container" style="width: 600px;">
        <div class="header">
          <div class="stat-chip">总计: <span>${totalMessages.toLocaleString()}</span></div>
          <h1 class="title-text">${title}</h1>
          <div class="time-label">${time.toLocaleString('zh-CN', { hour12: false })}</div>
        </div>
        <div class="chart-wrapper">
          <svg width="600" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
            ${svgElements}
          </svg>
        </div>
      </div>`;

    const chartStyles = ` .chart-wrapper { padding: 10px; box-sizing: border-box; } `;
    const fullHtml = this.generateFullHtml(cardHtml, chartStyles);
    const imageBuffer = await this.htmlToImage(fullHtml);
    if (imageBuffer) yield imageBuffer;
  }

  /**
   * @public
   * @method renderWordCloud
   * @description 将词频数据渲染成一张词云图片，使用 Puppeteer 和 wordcloud2.js。
   * @param {WordCloudData} data - 包含标题、时间和词汇列表的对象。
   * @param {Config} config - 插件的配置对象。
   * @returns {AsyncGenerator<Buffer>} - 一个异步生成器，产出渲染后的图片 Buffer。
   */
  public async *renderWordCloud(data: WordCloudData, config: Config): AsyncGenerator<Buffer> {
    const { title, time, words } = data;
    if (!words?.length) return;

    const weights = words.map(w => w[1]);
    const maxWeight = Math.max(...weights, 1);
    const minWeight = Math.max(Math.min(...weights), 1);
    const logMaxWeight = Math.log1p(maxWeight);
    const logMinWeight = Math.log1p(minWeight);
    const logWeightRange = logMaxWeight - logMinWeight;

    const getRelativeFontSize = (size: number): number => {
      if (logWeightRange <= 0) return 1;
      const normalizedWeight = (Math.log1p(size) - logMinWeight) / logWeightRange;
      return 0.05 + 0.95 * normalizedWeight;
    };

    let estimatedCurrentArea = 0;
    const relativeFontSizes = words.map(word => getRelativeFontSize(word[1]));

    for (let i = 0; i < words.length; i++) {
      const wordText = words[i][0];
      const relativeSize = relativeFontSizes[i];
      estimatedCurrentArea += Math.pow(relativeSize, 2) * wordText.length * 0.6;
    }

    const scalingFactor = Math.sqrt(600 * 600 * 0.9 / Math.max(1, estimatedCurrentArea));
    const wordList = words.map((word, i) => {
      let finalSize = relativeFontSizes[i] * scalingFactor;
      finalSize = Math.max(4, Math.min(128, finalSize));
      return [word[0], finalSize];
    });

    const cardHtml = `
      <div class="container" style="width: 600px;">
        <div class="header">
          <div class="stat-chip">词数: <span>${words.length}</span></div>
          <h1 class="title-text">${title}</h1>
          <div class="time-label">${time.toLocaleString('zh-CN', { hour12: false })}</div>
        </div>
        <div style="width: 600px; height: 600px; margin: auto;">
          <canvas id="wordcloud-container" width="600" height="600"></canvas>
        </div>
        <script>${wordCloudScript}</script>
        <script>
          const canvas = document.getElementById('wordcloud-container');
          const options = {
            fontFamily: ${JSON.stringify(config.fontFamily)},
            color: ${JSON.stringify(config.color)},
            shape: ${JSON.stringify(config.shape)},
            rotationSteps: ${config.rotationSteps},
            ellipticity: ${config.ellipticity},
            minRotation: ${config.minRotation},
            maxRotation: ${config.maxRotation},
            list: ${JSON.stringify(wordList)},
            weightFactor: (size) => size,
            backgroundColor: 'transparent',
            clearCanvas: ${!config.maskImage},
            shrinkToFit: true,
            rotateRatio: 1,
            shuffle: true,
            gridSize: 1,
          };

          const maskImageUrl = ${JSON.stringify(config.maskImage)};
          if (maskImageUrl) {
            const maskImage = new Image();
            maskImage.crossOrigin = "anonymous";
            maskImage.onload = () => {
              const ctx = canvas.getContext('2d');
              ctx.drawImage(maskImage, 0, 0, canvas.width, canvas.height);
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const data = imageData.data;
              for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] < 128) {
                  data[i] = 255;
                  data[i + 1] = 255;
                  data[i + 2] = 255;
                  data[i + 3] = 255;
                } else {
                  data[i + 3] = 0;
                }
              }
              ctx.putImageData(imageData, 0, 0);
              WordCloud(canvas, options);
            };
            maskImage.src = maskImageUrl;
          } else {
            WordCloud(canvas, options);
          }
        </script>
      </div>`;

    const fullHtml = `<!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <style>${this.COMMON_STYLE}</style>
        </head>
        <body>
          ${cardHtml}
        </body>
      </html>`;

    const imageBuffer = await this.htmlToImage(fullHtml);
    if (imageBuffer) yield imageBuffer;
  }
}
