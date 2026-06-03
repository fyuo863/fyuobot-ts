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

    console.log("     ");

    for (let y = 0; y < LOGO_LINES.length; y++) {
        const row = LOGO_LINES[y];
        let line = c.cyan(" │ ");
        let hasContent = false;

        for (let x = 0; x < 35; x++) {
            const char = row![x];
            const isMain = char === "█";
            const isShadow = y > 0 && x > 0 && LOGO_LINES[y - 1]?.[x - 1] === "█";

            if (isMain) {
                line += c.bgWhite(" ");
                hasContent = true;
            } else if (isShadow) {
                line += c.gray256("█");
                hasContent = true;
            } else {
                line += " ";
            }
        }
        line += "     ";
        if (hasContent || y < LOGO_LINES.length - 1) {
            console.log(line);
        }
    }

    console.log("     ");
    console.log(`  ${c.bold("📁 当前目录:")} ${process.cwd()}`);
    const extras: string[] = [`已加载 ${toolCount} 个工具`];
    if (slashCount !== undefined && slashCount > 0) {
        extras.push(`${slashCount} 个斜杠命令`);
    }
    console.log(`  ${c.dim(`💡 系统状态: ${extras.join("，")}`)}`);
    console.log("");
}
