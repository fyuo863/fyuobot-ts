import { BaseTool } from "./basetool.js";
import type { ToolParam } from "./basetool.js";

export class CalculatorTool extends BaseTool {
    name = "calculator";
    description = "执行数学表达式计算。支持基础的加减乘除、括号优先级，以及 JavaScript 所有的内置 Math 方法（如 Math.sqrt, Math.sin, Math.PI, Math.pow 等）。";

    parameters: ToolParam[] = [
        {
            name: "expression",
            type: "string",
            description: "要计算的数学表达式字符串，例如：'2 + 2', 'Math.PI * (5 ** 2)', 'Math.max(10, 20)'",
            required: true,
        }
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const expression = args["expression"] as string;

        try {
            // 使用 Function 构造器动态执行数学表达式
            // "use strict" 可以在一定程度上规范语法要求，避免一些隐式的全局变量污染
            // eslint-disable-next-line no-new-func
            const result = new Function(`"use strict"; return (${expression})`)();

            // 拦截并友好处理特殊的 JS 浮点数计算结果
            if (result === Infinity || result === -Infinity) {
                return `计算结果趋于无穷大 (${result})。`;
            }
            if (Number.isNaN(result)) {
                return `计算失败: 表达式 '${expression}' 的求值结果为 NaN (非数字)，请检查公式逻辑。`;
            }

            return `计算成功: ${result}`;
        } catch (error: any) {
            // 当表达式语法错误（比如括号不匹配、调用了不存在的方法）时，必须将错误喂回给大模型 [cite: 554]
            // 这能让大模型看到报错后，自行修改表达式并重新调用工具
            return `计算执行失败!\n[ERROR]: ${error.message}\n请检查表达式的语法是否正确，且只能使用合法的 JavaScript 数学运算。`;
        }
    }
}