// src/tools/database/db-read-tool.ts
//
// DbReadTool — 只读访问 SQLite 数据库，查看表结构、执行查询、获取统计。
// 专为 Agent 提供数据库内容探查能力，默认指向 .fyuobot/history/history.db。
//
// 安全约束：
//   - 仅允许 SELECT / PRAGMA 语句，拒绝写操作
//   - 查询结果默认限制 50 行，防止上下文溢出

import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BaseTool, type ToolParam } from "../basetool.js";

/** 默认数据库路径（相对于 cwd） */
const DEFAULT_DB = ".fyuobot/history/history.db";

/** 查询结果最大行数 */
const MAX_ROWS = 50;

/** 单单元格最大字符数 */
const MAX_CELL_LEN = 200;

export class DbReadTool extends BaseTool {
    name = "db_read";
    description = [
        "只读访问 SQLite 数据库。支持查看表列表、表结构、执行 SELECT 查询、数据库统计。",
        `默认目标: ${DEFAULT_DB}（对话历史归档）。`,
        "操作：",
        "- tables: 列出所有表名及行数",
        "- schema: 查看指定表的结构（列名、类型、约束）",
        "- query: 执行 SELECT 查询（只读，最多返回 50 行）",
        "- stats: 数据库文件大小、表数量等概览",
    ].join("\n");

    parameters: ToolParam[] = [
        {
            name: "action",
            type: "string",
            description: "操作：'tables'（表列表）、'schema'（表结构）、'query'（SQL 查询）、'stats'（统计）",
            required: true,
            enum: ["tables", "schema", "query", "stats"],
        },
        {
            name: "dbpath",
            type: "string",
            description: `SQLite 数据库路径，默认为 ${DEFAULT_DB}`,
            required: false,
        },
        {
            name: "sql",
            type: "string",
            description: "SELECT 查询语句（action=query 时必需）",
            required: false,
        },
        {
            name: "table",
            type: "string",
            description: "表名（action=schema 时必需）",
            required: false,
        },
    ];

    async execute(args: Record<string, unknown>): Promise<string> {
        const action = String(args.action ?? "");
        const dbpathRaw = args.dbpath ? String(args.dbpath) : DEFAULT_DB;
        const dbpath = resolve(process.cwd(), dbpathRaw);

        // ── 文件存在检查 ──
        if (!existsSync(dbpath)) {
            return `❌ 数据库文件不存在: ${dbpath}`;
        }

        let conn: DatabaseSync;
        try {
            conn = new DatabaseSync(dbpath, { open: true, readOnly: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 无法打开数据库: ${msg}`;
        }

        try {
            switch (action) {
                case "tables":
                    return this.#listTables(conn, dbpath);
                case "schema":
                    return this.#showSchema(conn, args);
                case "query":
                    return this.#runQuery(conn, args);
                case "stats":
                    return this.#showStats(conn, dbpath);
                default:
                    return `❌ 未知操作: "${action}"，可选: tables, schema, query, stats`;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 数据库操作失败: ${msg}`;
        } finally {
            conn.close();
        }
    }

    // ── 内部实现 ──────────────────────────────────────────────

    /** 列出所有表名及行数 */
    #listTables(conn: DatabaseSync, dbpath: string): string {
        const tables = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as Array<{ name: string }>;

        if (tables.length === 0) {
            return `[数据库: ${dbpath}]\n没有用户表。`;
        }

        const lines: string[] = [
            `[数据库: ${dbpath}]  表数量: ${tables.length}`,
            `${"—".repeat(48)}`,
        ];

        for (const { name } of tables) {
            const count = (
                conn.prepare(`SELECT COUNT(*) as cnt FROM "${name}"`).get() as {
                    cnt: number;
                }
            ).cnt;
            lines.push(`  ${name.padEnd(24)} ${String(count).padStart(6)} 行`);
        }

        return lines.join("\n");
    }

    /** 查看指定表的结构 */
    #showSchema(
        conn: DatabaseSync,
        args: Record<string, unknown>,
    ): string {
        const table = String(args.table ?? "");
        if (!table) return "❌ schema 操作需要提供 table 参数（表名）。";

        // 用 PRAGMA table_info 获取列信息
        let columns: Array<{
            cid: number;
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
        }>;
        try {
            columns = conn
                .prepare(`PRAGMA table_info("${table}")`)
                .all() as typeof columns;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 无法读取表结构: ${msg}`;
        }

        if (columns.length === 0) {
            return `❌ 表 "${table}" 不存在或没有列。`;
        }

        const count = (
            conn.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get() as {
                cnt: number;
            }
        ).cnt;

        const lines: string[] = [
            `[表: ${table}]  列数: ${columns.length}  行数: ${count}`,
            `${"—".repeat(64)}`,
            `  ${"列名".padEnd(20)} ${"类型".padEnd(14)} ${"非空".padEnd(6)} ${"主键".padEnd(6)} 默认值`,
            `${"—".repeat(64)}`,
        ];

        for (const col of columns) {
            const notnull = col.notnull ? "✓" : "";
            const pk = col.pk ? "✓" : "";
            const dflt = col.dflt_value ?? "";
            lines.push(
                `  ${col.name.padEnd(20)} ${col.type.padEnd(14)} ${notnull.padEnd(6)} ${pk.padEnd(6)} ${dflt}`,
            );
        }

        // 附上 CREATE TABLE 原文
        const createRow = conn
            .prepare(
                `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
            )
            .get(table) as { sql: string } | undefined;

        if (createRow?.sql) {
            lines.push("");
            lines.push("── DDL ──");
            lines.push(createRow.sql);
        }

        return lines.join("\n");
    }

    /** 执行 SELECT 查询 */
    #runQuery(
        conn: DatabaseSync,
        args: Record<string, unknown>,
    ): string {
        const sql = (String(args.sql ?? "")).trim();
        if (!sql) return "❌ query 操作需要提供 sql 参数（SELECT 语句）。";

        // ── 安全防护：仅允许只读语句 ──
        const upper = sql.toUpperCase();
        const allowedPrefixes = ["SELECT", "PRAGMA", "EXPLAIN", "WITH"];
        const hasAllowedPrefix = allowedPrefixes.some((p) =>
            upper.startsWith(p),
        );
        if (!hasAllowedPrefix) {
            return `❌ 出于安全考虑，仅允许 SELECT / PRAGMA / EXPLAIN / WITH 查询。被拒绝: ${sql.slice(0, 80)}`;
        }

        // 额外拦截危险关键词
        const dangerous = [
            /\bDROP\b/i,
            /\bDELETE\b/i,
            /\bINSERT\b/i,
            /\bUPDATE\b/i,
            /\bALTER\b/i,
            /\bCREATE\b/i,
            /\bATTACH\b/i,
            /\bDETACH\b/i,
        ];
        for (const pattern of dangerous) {
            if (pattern.test(upper)) {
                return `❌ 查询包含危险操作 (${pattern.source})，仅允许只读查询。`;
            }
        }

        // ── 执行 ──
        let rows: Array<Record<string, unknown>>;
        try {
            rows = conn.prepare(sql).all() as typeof rows;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `❌ 查询执行失败: ${msg}`;
        }

        if (rows.length === 0) {
            return `查询返回 0 行。`;
        }

        const columns = Object.keys(rows[0]!);

        // 计算列宽（限制最大宽度）
        const widths: number[] = columns.map((c) => c.length);
        for (const row of rows.slice(0, MAX_ROWS)) {
            for (let i = 0; i < columns.length; i++) {
                const val = String(row[columns[i]!] ?? "NULL");
                widths[i] = Math.min(
                    Math.max(widths[i]!, val.length),
                    MAX_CELL_LEN,
                );
            }
        }

        // ── 输出 ──
        const overflow = rows.length > MAX_ROWS ? ` (显示前 ${MAX_ROWS} 行，共 ${rows.length} 行)` : "";
        const lines: string[] = [
            `[查询结果]  列数: ${columns.length}  行数: ${rows.length}${overflow}`,
            `${"—".repeat(Math.min(80, widths.reduce((a, b) => a + b + 3, 0)))}`,
        ];

        // 表头
        const header = columns
            .map((c, i) => c.padEnd(widths[i]!))
            .join(" │ ");
        lines.push(header);
        lines.push(
            columns.map((_, i) => "─".repeat(widths[i]!)).join("─┼─"),
        );

        // 数据行
        for (const row of rows.slice(0, MAX_ROWS)) {
            const cells = columns.map((c, i) => {
                let val = String(row[c] ?? "NULL");
                if (val.length > MAX_CELL_LEN) {
                    val = val.slice(0, MAX_CELL_LEN) + "…";
                }
                return val.padEnd(widths[i]!);
            });
            lines.push(cells.join(" │ "));
        }

        return lines.join("\n");
    }

    /** 数据库统计概览 */
    #showStats(conn: DatabaseSync, dbpath: string): string {
        const tables = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all() as Array<{ name: string }>;

        const indexCount = (
            conn
                .prepare(
                    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='index'",
                )
                .get() as { cnt: number }
        ).cnt;

        // 总行数（各表行数之和）
        let totalRows = 0;
        for (const { name } of tables) {
            const count = (
                conn.prepare(`SELECT COUNT(*) as cnt FROM "${name}"`).get() as {
                    cnt: number;
                }
            ).cnt;
            totalRows += count;
        }

        let fileSizeKB = 0;
        try {
            fileSizeKB = Math.round(statSync(dbpath).size / 1024);
        } catch { /* ignore */ }

        return [
            `📊 数据库统计: ${dbpath}`,
            `${"—".repeat(40)}`,
            `  表数量:     ${tables.length}`,
            `  索引数量:   ${indexCount}`,
            `  总行数:     ${totalRows}`,
            `  文件大小:   ${fileSizeKB} KB`,
        ].join("\n");
    }
}
