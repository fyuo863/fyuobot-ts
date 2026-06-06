import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

/**
 * 测试用时间工具 —— 返回当前日期时间。
 * 支持可选参数 format（输出格式），演示多参数工具的定义方式。
 */
export class TestTool extends BaseTool {
    name = "test-tool";
    description = "进行工具测试。传入字符串，输出相同字符串";

    parameters: ToolParam[] = [
        {
            name: "input",
            type: "string",
            description: "要测试的输入字符串",
            required: true,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const input = args["input"] as string;
        return `测试结果: ${input}`;
    }
}

export class TestTool2 extends BaseTool {
    name = "test-tool2";
    description = "进行工具测试。传入字符串，输出相同字符串";

    parameters: ToolParam[] = [
        {
            name: "input",
            type: "string",
            description: "要测试的输入字符串",
            required: true,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const input = args["input"] as string;
        return `测试结果: ${input}`;
    }
}

export class TestTool3 extends BaseTool {
    name = "test-tool3";
    description = "在终端原地刷新一个进度条，5秒内从0走到100%";

    // 这个工具不需要强制传入参数，但为了保持格式，我们给一个可选的标题参数
    parameters: ToolParam[] = [
        {
            name: "title",
            type: "string",
            description: "进度条的标题（可选）",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const title = (args["title"] as string) || "Loading";
        const totalDuration = 5000; // 总时间 5 秒 (5000 毫秒)
        const updateInterval = 50;  // 每 50 毫秒刷新一次
        const totalSteps = totalDuration / updateInterval; // 一共 100 步
        const barLength = 40;       // 进度条的视觉长度

        // 隐藏终端光标，让进度条看起来更干净
        process.stdout.write("\x1B[?25l");

        for (let i = 0; i <= totalSteps; i++) {
            const percent = (i / totalSteps) * 100;
            // 计算进度条填充数量
            const filledLength = Math.round((barLength * i) / totalSteps);
            // 生成形如 ████████---------- 的进度条
            const bar = "█".repeat(filledLength) + "-".repeat(barLength - filledLength);

            // \r 是核心：将光标移到行首，重新覆写这一行
            process.stdout.write(`\r${title}: [${bar}] ${percent.toFixed(0)}%`);

            // 等待指定的间隔时间
            await new Promise((resolve) => setTimeout(resolve, updateInterval));
        }

        // 进度结束后恢复终端光标，并输出一个换行符，以免后续的控制台输出连在一行
        process.stdout.write("\x1B[?25h\n");

        return "进度条展示完毕，已成功到达100%！";
    }
}

export class TestTool4 extends BaseTool {
    name = "TestTool4";
    description = "测试工具动态输出。5秒内从0走到100%，实时刷新进度条给Agent。";

    parameters: ToolParam[] = [
        {
            name: "title",
            type: "string",
            description: "进度条的标题（可选）",
            required: false,
        },
    ];

    // 🌟 严格匹配基类的签名：增加第二个参数 onProgress
    async execute(
        args: Record<string, unknown>, 
        onProgress?: (chunk: string) => void
    ): Promise<string> {
        const title = (args["title"] as string) || "Loading";
        const totalDuration = 5000; 
        const totalSteps = 20; // 拆分为20步，每步250ms
        const updateInterval = totalDuration / totalSteps;
        const barLength = 30;

        for (let i = 0; i <= totalSteps; i++) {
            const percent = (i / totalSteps) * 100;
            const filledLength = Math.round((barLength * i) / totalSteps);
            // 进度条样式：████████░░░░
            const bar = "█".repeat(filledLength) + "░".repeat(barLength - filledLength);
            
            const progressText = `${title}: [${bar}] ${percent.toFixed(0)}%\n`;

            // 🌟 核心：如果 Agent 框架传递了动态刷新回调，则调用它推给前端 UI
            if (onProgress) {
                onProgress(progressText);
            }

            // 在 Node 后台终端也原地打印一下，方便双向对照观察
            process.stdout.write(`\r[后台终端] ${title}: [${bar}] ${percent.toFixed(0)}%`);

            await new Promise((resolve) => setTimeout(resolve, updateInterval));
        }

        // 终端换行，避免后续日志错乱
        console.log("");

        return "✅ 进度条展示完毕，已成功到达100%！";
    }
}
