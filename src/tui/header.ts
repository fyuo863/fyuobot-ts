// src/tui/header.ts
//
// 启动 Logo 渲染 —— bootstrap 和 /clean 命令共用。
// 使用 console.log 直接写入 stdout（非 Ink 渲染），
// 作为终端滚动历史的一部分。

import process from "process";
import { c } from "./colors.js";

/** 打印 fyuobot ASCII Logo 及环境信息 */
export function printSystemHeader(toolCount: number, slashCount?: number) {
    const LOGO_LINES = [
        "  ██  █  █ █  █  ██  █     ██   █  ",
        "  █   █  █ █  █ █  █ ███  █  █ ███ ",
        "  ███  ███ █  █ █  █ █  █ █  █  █  ",
        "  █      █  ██   ██  ███   ██   ██ ",
        "",
    ];

    const HEIGHT = LOGO_LINES.length;
    const WIDTH = 35;

    /** 核心主形状判定：容错处理越界坐标 */
    function isMain(x: number, y: number): boolean {
        if (y < 0 || y >= HEIGHT) return false;
        const row = LOGO_LINES[y];
        if (!row || x < 0 || x >= row.length) return false;
        return row[x] === "█";
    }

    /**
     * 严格 3D 轴测线框算法
     * 针对坐标 (x,y) 计算应绘制的阴影字符（若无则返回 null）
     */
    function getShadowChar(x: number, y: number): string | null {
        // 规则 1：主方块本身不绘制阴影（阴影在背景层）
        if (isMain(x, y)) return null;

        // 提取相邻三个关键格子的状态
        const is_left = isMain(x - 1, y);
        const is_top_left = isMain(x - 1, y - 1);
        const is_top = isMain(x, y - 1);

        // ==========================================
        // 规则 1.5：内角与交叉口特判 (新增)
        // 使用 || 提供默认值，解决 TypeScript string | undefined 的类型报错
        // ==========================================
        // 条件 1：左、左上、上 均存在实体格子，此时是“内凹角”，阴影向右下延伸
        if (is_left && is_top_left && is_top) {
            return BOX_DRAWING[0b1010] || "╔"; // "╔" (down + right)
        }
        
        // 条件 2：左、上 存在实体格子（且左上为空），此时是实体对角拼接造成的十字交叉
        if (is_left && !is_top_left && is_top) {
            return BOX_DRAWING[0b1111] || "╬"; // "╬" (all)
        }
        // ==========================================

        // 规则 2：追踪暴露的 3D 侧面 (从上方或左侧的主方块投射)
        // base_up: 左上角方块的右侧面延伸下来的垂直线 (需要上方没有被其他方块遮挡)
        const base_up = is_top_left && !is_top;
        // base_down: 左侧方块的右侧面 (当前单元格正是它的投影区)
        const base_down = is_left;
        // base_left: 左上角方块的底面延伸过来的水平线 (需要左侧没有被其他方块遮挡)
        const base_left = is_top_left && !is_left;
        // base_right: 上方方块的底面 (当前单元格正是它的投影区)
        const base_right = is_top;

        // 规则 3：边缘封口 (Capping)
        // 当一条投影线无处可去时，必须转向连接到旁边的实体方块上，形成闭合的线框
        const cap_up = base_right && !base_left;
        const cap_left = base_down && !base_up;

        // 最终的四向连接性
        const up = base_up || cap_up;
        const down = base_down;
        const left = base_left || cap_left;
        const right = base_right;

        // 4-bit 二进制编码求值
        const code = (up ? 1 : 0) | (down ? 2 : 0) | (left ? 4 : 0) | (right ? 8 : 0);
        if (code === 0) return null;
        return BOX_DRAWING[code] || " "; // 同样提供兜底解决类型问题
    }

    console.log("");

    // 为了防止最右下角的阴影被截断，高度和宽度各增加 2
    for (let y = 0; y <= HEIGHT + 1; y++) {
        let line = c.cyan(" │ ");
        let hasContent = false;

        for (let x = 0; x <= WIDTH + 2; x++) {
            if (isMain(x, y)) {
                // 为了与你的最终截图无缝对接，这里使用高亮前景色代替背景色
                line += c.hex("#d9826a", "█");
                hasContent = true;
            } else {
                const shadow = getShadowChar(x, y);
                if (shadow) {
                    // 阴影与主方块同色，形成赛博电路质感
                    line += c.hex("#8d5444", shadow);
                    hasContent = true;
                } else {
                    line += " ";
                }
            }
        }
        line += "     ";
        if (hasContent || y < HEIGHT) {
            console.log(line);
        }
    }

    console.log("");
    console.log(`  ${c.bold("📁 当前目录:")} ${process.cwd()}`);
    const extras: string[] = [`已加载 ${toolCount} 个工具`];
    if (slashCount !== undefined && slashCount > 0) {
        extras.push(`${slashCount} 个斜杠命令`);
    }
    console.log(`  ${c.dim(`💡 系统状态: ${extras.join("，")}`)}`);
    console.log("");
}

// ════════════════════════════════════════════════════════════
// 4-bit Box-drawing 字符对照表 (up=1, down=2, left=4, right=8)
// 使用双线字符严丝合缝匹配图 2 样式
// ════════════════════════════════════════════════════════════
const BOX_DRAWING: Record<number, string> = {
    0b0000: " ",
    0b0001: "║", // 1: up
    0b0010: "║", // 2: down
    0b0011: "║", // 3: up+down
    0b0100: "═", // 4: left
    0b0101: "╝", // 5: up+left
    0b0110: "╗", // 6: down+left
    0b0111: "╣", // 7: up+down+left
    0b1000: "═", // 8: right
    0b1001: "╚", // 9: up+right
    0b1010: "╔", // 10: down+right
    0b1011: "╠", // 11: up+down+right
    0b1100: "═", // 12: left+right
    0b1101: "╩", // 13: up+left+right
    0b1110: "╦", // 14: down+left+right
    0b1111: "╬", // 15: all
};