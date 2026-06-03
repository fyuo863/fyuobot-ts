import * as process from "process";

// 1. 终端环境嗅探：判断当前终端支持的色彩级别
const isTTY = process.stdout.isTTY;
const env = process.env;

// 检查是否支持真彩色 (24-bit True Color)
const supportsTrueColor = isTTY && (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit');
// 检查是否支持 256 色
const supports256 = isTTY && (env.TERM?.includes('256') || supportsTrueColor);
// 检查是否支持基础 16 色
const supportsColor = isTTY && env.TERM !== 'dumb';

// ==========================================
// 💡 核心算法：将 RGB 动态降级转换为 256 色调色板索引
// 256色是由 16个基础色 + 216个色彩立方(6x6x6) + 24阶灰度 组成的
// ==========================================
function rgbTo256(r: number, g: number, b: number): number {
    // 如果三个值相等，优先映射到 24 阶灰度区 (索引 232-255)
    if (r === g && g === b) {
        if (r === 255) return 231;
        if (r === 0) return 16;
        return Math.round(((r / 255) * 23) + 232);
    }
    // 映射到 6x6x6 的 216 色立方 (索引 16-231)
    const rIdx = Math.round((r / 255) * 5);
    const gIdx = Math.round((g / 255) * 5);
    const bIdx = Math.round((b / 255) * 5);
    return 16 + (36 * rIdx) + (6 * gIdx) + bIdx;
}

// 基础重置符
const RESET = "\x1b[0m";

// 包装器：如果不支持颜色，直接返回纯文本
const wrap = (code: string, text: string) => supportsColor ? `${code}${text}${RESET}` : text;

export const c = {
    // ========== 动态真彩色 (自动向下兼容) ==========
    
    /**
     * RGB 前景色渲染
     * @param r 红色 (0-255)
     * @param g 绿色 (0-255)
     * @param b 蓝色 (0-255)
     * @param text 需要渲染的文本
     */
    rgb: (r: number, g: number, b: number, text: string) => {
        if (supportsTrueColor) {
            return wrap(`\x1b[38;2;${r};${g};${b}m`, text);
        }
        if (supports256) {
            const index = rgbTo256(r, g, b);
            return wrap(`\x1b[38;5;${index}m`, text);
        }
        return wrap("\x1b[39m", text); // 降级为终端默认前景色
    },

    /**
     * HEX 格式前景色渲染 (例如 "#1E1E1E")
     */
    hex: (hex: string, text: string) => {
        const cleanHex = hex.replace("#", "");
        const r = parseInt(cleanHex.substring(0, 2), 16) || 0;
        const g = parseInt(cleanHex.substring(2, 4), 16) || 0;
        const b = parseInt(cleanHex.substring(4, 6), 16) || 0;
        return c.rgb(r, g, b, text);
    },

    // ========== 基础样式 (对应你截图里的常用格式) ==========
    
    cyan: (text: string) => wrap("\x1b[36m", text),
    bgWhite: (text: string) => wrap("\x1b[47m", text),
    gray256: (text: string) => wrap("\x1b[38;5;235m", text), // 你之前用的 235 暗灰
    
    // 文字修饰
    bold: (text: string) => wrap("\x1b[1m", text), // 对应 \x1b[1m
    dim: (text: string) => wrap("\x1b[2m", text),  // 对应 \x1b[2m
    
    // 清除转义残留的辅助方法
    clearLine: "\x1b[2K",
    hideCursor: "\x1b[?25l",
    showCursor: "\x1b[?25h",
};