/**
 * Hindsight 记忆插件 · 浏览器端配置面板。
 *
 * 🔴 这是**浏览器经典脚本**，不是 Node 模块：没有 import/export，
 *    所有依赖都通过工厂函数的 require() 拿。DSH 的 client-modules
 *    把这个文件当 classic script 载入，再由下面的 factory 交给模块表。
 *
 * 为什么要自己写面板：DSH 插件管理页的「配置」按钮来自 client 侧 slot
 * `plugins.row.config`，**只有注册了这个 slot 的包才会出现该按钮**
 * （config-ledger 的 rows 集合 = 已注册 slot 的 key 集合）。
 * 没有 occupant ⇒ 页面上既没有按钮也没有表单 —— 这就是「没有面板」的根因。
 *
 * 本文件注册 key = `<bundle 包名>#<patch 行 id>` = dsh-hindsight-memory#hindsight-memory
 * （插件管理页用同一个函数 rowConfigKey(bundle, rowId) 计算点击目标，两边必须一致）。
 *
 * 表单契约（dsh-client-ui-settings/lib/types/client/config-form-types.d.ts）：
 *   props.form.state = { status, value, base, user, revision, writable }
 *   props.form.mutate(ops, revision) → Promise<boolean>
 *   ops = { op: "set", path: [field], value } | { op: "unset", path: [field] }
 */

window.__ModuleLoader__.load({
	id: "dsh-hindsight-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useCallback, useEffect, useMemo, useState } = react;

		/**
		 * 字段表：与 src/config.js 的 DEFAULTS / FIELD_DOCS 一一对应。
		 * （浏览器端不能 import 宿主模块，所以文案在这里镜像一份；改动时两处同步。）
		 */
		const FIELDS = [
			{
				group: "连接",
				key: "apiUrl",
				label: "服务地址",
				type: "text",
				default: "http://127.0.0.1:8888",
				doc: "Hindsight 服务根地址。本机 8888 = API，9999 = Control Plane 前端。",
			},
			{
				group: "连接",
				key: "transport",
				label: "传输层",
				type: "select",
				options: ["mcp", "rest"],
				default: "mcp",
				doc: "mcp = 服务端官方 per-bank 端点 /mcp/<bank>/；rest = 公开 REST API。两者语义一致。",
			},
			{
				group: "连接",
				key: "bankId",
				label: "记忆库 bank",
				type: "text",
				default: "shared",
				doc: "必须与 omp 的 hindsight.bankId 一致（当前 shared）。项目隔离靠标签，不靠库名。",
			},
			{
				group: "连接",
				key: "bankIdPrefix",
				label: "bank 前缀",
				type: "text",
				default: "",
				doc: "对应 omp 的 hindsight.bankIdPrefix。留空。",
			},
			{
				group: "行为",
				key: "enabled",
				label: "启用插件",
				type: "bool",
				default: true,
				doc: "总开关。false ⇒ 不注册工具、不发任何网络请求。",
			},
			{
				group: "行为",
				key: "inject",
				label: "注入记忆行为规约",
				type: "bool",
				default: true,
				doc: "是否往系统提示词里注入常驻的记忆行为段（对模型是背景知识，不是指令）。",
			},
			{
				group: "行为",
				key: "writeEnabled",
				label: "允许写入",
				type: "bool",
				default: true,
				doc: "false ⇒ 只读挂载（retain 被拒）。灰度第一步就用这个。",
			},
			{
				group: "行为",
				key: "autoRecall",
				label: "首轮自动召回",
				type: "bool",
				default: true,
				doc: "会话首轮自动召回一次，结果落用户消息，不污染缓存前缀。",
			},
			{
				group: "行为",
				key: "autoRetain",
				label: "回合结束自动留存",
				type: "bool",
				default: true,
				doc: "回合结束把本轮结论写进记忆库。",
			},
			{
				group: "行为",
				key: "retainEveryNTurns",
				label: "自动留存间隔（回合）",
				type: "number",
				default: 3,
				doc: "对齐 omp 的 retainEveryNTurns 默认 3。",
			},
			{
				group: "隔离",
				key: "scoping",
				label: "作用域模式",
				type: "select",
				options: ["global", "per-project", "per-project-tagged"],
				default: "per-project-tagged",
				doc: "global = 单库不隔离；per-project = 每项目一个库（硬隔离、无全局层）；per-project-tagged = 单库 + project:<标签> 过滤（推荐，与 omp 一致）。",
			},
			{
				group: "隔离",
				key: "projectLabelOverride",
				label: "项目标签覆盖",
				type: "text",
				default: "",
				doc: "留空 ⇒ 自动取 git 主 checkout 根目录 basename 小写（与 omp 同规则）。",
			},
			{
				group: "召回",
				key: "types",
				label: "事实类型",
				type: "list",
				default: ["world", "experience"],
				doc: "服务端只认 world / observation / experience；逗号分隔。默认与 omp 的 recallTypes 同值。",
			},
			{
				group: "召回",
				key: "budget",
				label: "召回预算",
				type: "select",
				options: ["low", "mid", "high"],
				default: "mid",
				doc: "对应 omp 的 hindsight.recallBudget。",
			},
			{
				group: "召回",
				key: "reflectBudget",
				label: "综合问答预算",
				type: "select",
				options: ["low", "mid", "high"],
				default: "low",
				doc: "reflect 的预算，omp 固定用 low。",
			},
			{
				group: "召回",
				key: "maxTokens",
				label: "单次召回上限（token）",
				type: "number",
				default: 1024,
				doc: "对应 omp 的 recallMaxTokens。",
			},
			{
				group: "召回",
				key: "recallMaxQueryChars",
				label: "召回 query 截断（字符）",
				type: "number",
				default: 800,
				doc: "超长取尾部，与 omp 同规则。",
			},
			{
				group: "进阶",
				key: "sectionOrder",
				label: "注入段顺序",
				type: "number",
				default: 950,
				doc: "字面数字。落在 FILE_REFERENCE(900) 与 TOOL_BASH(1000) 之间。",
			},
			{
				group: "进阶",
				key: "recallTimeoutMs",
				label: "召回超时（ms）",
				type: "number",
				default: 30000,
				doc: "对应 omp 的 recallTimeoutMs。",
			},
			{
				group: "进阶",
				key: "retainTimeoutMs",
				label: "写入超时（ms）",
				type: "number",
				default: 60000,
				doc: "对应 omp 的 retainTimeoutMs。",
			},
			{
				group: "进阶",
				key: "reflectTimeoutMs",
				label: "综合问答超时（ms）",
				type: "number",
				default: 120000,
				doc: "对应 omp 的 reflectTimeoutMs。",
			},
			{
				group: "记忆卫生",
				key: "hygieneThreshold",
				label: "近重复阈值（0-1）",
				type: "number",
				default: 0.9,
				doc: "越高越保守。0.9 只抓逐字重复，0.8 能抓「同一件事换个说法」。",
			},
			{
				group: "记忆卫生",
				key: "hygieneMaxFacts",
				label: "单次扫描条数上限",
				type: "number",
				default: 500,
				doc: "防 O(n²) 爆掉；超过这个规模建议先按类型分批。",
			},
			{
				group: "记忆卫生",
				key: "hygieneProjectMaxObservations",
				label: "项目层 observation 上限",
				type: "number",
				default: 40,
				doc: "写入 bank 的 consolidation_strategies（项目层 scope）。",
			},
			{
				group: "记忆卫生",
				key: "hygieneGlobalMaxObservations",
				label: "全局层 observation 上限",
				type: "number",
				default: 30,
				doc: "bank 级 max_observations_per_scope（无标签 scope 只能走 bank 默认）。",
			},
			{
				group: "记忆卫生",
				key: "hygieneScope",
				label: "默认作用的层",
				type: "select",
				default: "all",
				options: ["all", "project", "global", "other"],
				doc: "project=本项目层，global=跨项目全局层（无 tag），other=其它项目层，all=整库。",
			},
			{
				group: "精神模型",
				key: "mentalModels",
				label: "启用精神模型层",
				type: "boolean",
				default: true,
				doc: "服务端从事实层归纳出的长期画像。omp 侧有，DSH 侧补齐才算行为对齐。",
			},
			{
				group: "精神模型",
				key: "injectMentalModels",
				label: "会话首轮注入正文",
				type: "boolean",
				default: true,
				doc: "与 omp 对齐：首轮把精神模型正文作为背景知识注入（走用户消息，不进缓存前缀）。",
			},
			{
				group: "精神模型",
				key: "mentalModelPrefix",
				label: "模型 id 前缀",
				type: "text",
				default: "dsh",
				doc: "与 omp 的 id 空间分开，避免 409 冲突与 tags 抢写。",
			},
			{
				group: "精神模型",
				key: "mentalModelUserMaxTokens",
				label: "用户偏好模型 token",
				type: "number",
				default: 600,
				doc: "全局精神模型（user-preferences）的最大 token。",
			},
			{
				group: "精神模型",
				key: "mentalModelProjectMaxTokens",
				label: "项目模型 token",
				type: "number",
				default: 800,
				doc: "项目级精神模型（conventions / decisions）的最大 token。",
			},
			{
				group: "运维",
				key: "operationsLimit",
				label: "任务队列条数",
				type: "number",
				default: 20,
				doc: "状态查询里列多少条 operation。失败任务不会自动重试，要盯着。",
			},
			{
				group: "知识页",
				key: "knowledgePages",
				label: "启用知识页层",
				type: "boolean",
				default: true,
				doc: "知识页（服务端合成的长文）与 initiative 登记。关掉就不注册这两个工具。",
			},
			{
				group: "知识页",
				key: "pageSearchLimit",
				label: "检索条数",
				type: "number",
				default: 5,
				doc: "memory_pages search 默认返回条数。",
			},
			{
				group: "知识页",
				key: "pageMaxTokens",
				label: "页正文 token",
				type: "number",
				default: 2000,
				doc: "知识页正文合成上限（服务端硬下限 256）。",
			},
			{
				group: "知识页",
				key: "initiativeFolder",
				label: "Initiative 文件夹",
				type: "text",
				default: "Initiatives",
				doc: "initiative（正在做的事）页存放的文件夹名。",
			},
		];

		const GROUPS = [
			"连接",
			"行为",
			"隔离",
			"召回",
			"记忆卫生",
			"精神模型",
			"知识页",
			"运维",
			"进阶",
		];

		const STYLE = {
			wrap: {
				display: "flex",
				flexDirection: "column",
				gap: "18px",
				padding: "4px 2px 12px",
			},
			group: {
				border: "1px solid var(--dsh-border-subtle, rgba(127,127,127,0.25))",
				borderRadius: "10px",
				padding: "14px 16px",
				display: "flex",
				flexDirection: "column",
				gap: "12px",
			},
			groupTitle: {
				fontSize: "13px",
				fontWeight: "600",
				letterSpacing: "0.04em",
				textTransform: "uppercase",
				opacity: "0.65",
				margin: 0,
			},
			row: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
			},
			label: {
				fontSize: "13px",
				fontWeight: "600",
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flexWrap: "wrap",
			},
			doc: { fontSize: "12px", opacity: "0.6", margin: 0 },
			input: {
				fontSize: "13px",
				padding: "6px 9px",
				borderRadius: "6px",
				border: "1px solid var(--dsh-border-subtle, rgba(127,127,127,0.3))",
				background: "transparent",
				color: "inherit",
				width: "100%",
				boxSizing: "border-box",
			},
			actions: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
			btn: {
				fontSize: "12px",
				padding: "4px 10px",
				borderRadius: "6px",
				border: "1px solid var(--dsh-border-subtle, rgba(127,127,127,0.3))",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
			},
			btnPrimary: {
				fontSize: "12px",
				padding: "4px 12px",
				borderRadius: "6px",
				border: "1px solid transparent",
				background: "var(--dsh-accent, #3b6ef5)",
				color: "#fff",
				cursor: "pointer",
			},
			tag: {
				fontSize: "11px",
				opacity: "0.55",
				border: "1px solid var(--dsh-border-subtle, rgba(127,127,127,0.25))",
				borderRadius: "999px",
				padding: "1px 8px",
			},
			note: {
				fontSize: "12px",
				opacity: "0.7",
				borderLeft: "2px solid var(--dsh-border-subtle, rgba(127,127,127,0.3))",
				paddingLeft: "10px",
				margin: 0,
			},
			status: { fontSize: "12px", opacity: "0.8" },
		};

		/** 把界面输入的原始字符串转成该字段的正确类型。 */
		function coerce(spec, raw) {
			if (spec.type === "bool") return raw === true || raw === "true" || raw === "on";
			if (spec.type === "number") {
				const n = Number(raw);
				return Number.isFinite(n) ? Math.trunc(n) : spec.default;
			}
			if (spec.type === "list") {
				return String(raw)
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean);
			}
			return String(raw ?? "");
		}

		/** 当前值渲染成输入框可用的字符串。 */
		function display(spec, value) {
			if (value === undefined || value === null) return "";
			if (spec.type === "list") return Array.isArray(value) ? value.join(", ") : String(value);
			if (spec.type === "bool") return value ? "true" : "false";
			return String(value);
		}

		function FieldRow(props) {
			const { spec, effective, draft, onDraft, onSave, onClear, writable } = props;
			const dirty = draft !== undefined && draft !== display(spec, effective);
			const current = draft !== undefined ? draft : display(spec, effective);
			const inputProps = {
				id: `hindsight-memory-${spec.key}`,
				style: STYLE.input,
				value: current,
				disabled: !writable,
				onChange: (event) => onDraft(spec.key, event.target.value),
				onKeyDown: (event) => {
					if (event.key === "Enter") onSave(spec);
				},
			};
			let control;
			if (spec.type === "bool") {
				control = h("select", { ...inputProps, style: { ...STYLE.input, width: "auto" } }, [
					h("option", { key: "true", value: "true" }, "开启"),
					h("option", { key: "false", value: "false" }, "关闭"),
				]);
			} else if (spec.type === "select") {
				control = h(
					"select",
					{ ...inputProps, style: { ...STYLE.input, width: "auto" } },
					spec.options.map((option) => h("option", { key: option, value: option }, option)),
				);
			} else {
				control = h("input", { ...inputProps, type: spec.type === "number" ? "number" : "text" });
			}
			return h("div", { style: STYLE.row }, [
				h("label", { style: STYLE.label, htmlFor: `hindsight-memory-${spec.key}` }, [
					spec.label,
					h("code", { style: STYLE.tag }, spec.key),
					h("span", { style: STYLE.tag }, `默认 ${display(spec, spec.default)}`),
				]),
				control,
				h("p", { style: STYLE.doc }, spec.doc),
				h("div", { style: STYLE.actions }, [
					h(
						"button",
						{
							type: "button",
							style: STYLE.btnPrimary,
							disabled: !writable || !dirty,
							onClick: () => onSave(spec),
						},
						"保存",
					),
					h(
						"button",
						{
							type: "button",
							style: STYLE.btn,
							disabled: !writable,
							onClick: () => onClear(spec),
						},
						"恢复默认",
					),
				]),
			]);
		}

		/**
		 * 插件行配置页。
		 * @param {any} props 宿主给的 owner props：view / form。
		 */
		function HindsightMemoryConfig(props) {
			const view = props?.view;
			const form = props?.form;
			const [drafts, setDrafts] = useState({});
			const [status, setStatus] = useState(null);

			useEffect(() => {
				setDrafts({});
				setStatus(null);
			}, []);

			const onDraft = useCallback((field, value) => {
				setDrafts((prev) => ({ ...prev, [field]: value }));
			}, []);

			const snapshot = form?.state;
			const value = snapshot?.value ?? {};
			const writable = snapshot?.writable === true;

			const onSave = useCallback(
				async (spec) => {
					if (!form) return;
					const raw = drafts[spec.key] !== undefined ? drafts[spec.key] : display(spec, value[spec.key]);
					const next = coerce(spec, raw);
					setStatus({ field: spec.key, state: "saving" });
					try {
						const ok = await form.mutate(
							[{ op: "set", path: [spec.key], value: next }],
							snapshot?.revision,
						);
						setStatus({
							field: spec.key,
							state: ok ? "saved" : "rejected",
						});
						if (ok) {
							setDrafts((prev) => {
								const next2 = { ...prev };
								delete next2[spec.key];
								return next2;
							});
						}
					} catch (error) {
						setStatus({ field: spec.key, state: "error", message: String(error?.message ?? error) });
					}
				},
				[form, drafts, snapshot?.revision, value],
			);

			const onClear = useCallback(
				async (spec) => {
					if (!form) return;
					setStatus({ field: spec.key, state: "saving" });
					try {
						const ok = await form.mutate([{ op: "unset", path: [spec.key] }], snapshot?.revision);
						setStatus({ field: spec.key, state: ok ? "saved" : "rejected" });
						if (ok) {
							setDrafts((prev) => {
								const next = { ...prev };
								delete next[spec.key];
								return next;
							});
						}
					} catch (error) {
						setStatus({ field: spec.key, state: "error", message: String(error?.message ?? error) });
					}
				},
				[form, snapshot?.revision],
			);

			const grouped = useMemo(() => {
				const map = new Map();
				for (const group of GROUPS) map.set(group, []);
				for (const spec of FIELDS) {
					if (!map.has(spec.group)) map.set(spec.group, []);
					map.get(spec.group).push(spec);
				}
				return map;
			}, []);

			if (view === "summary") return null;

			if (!form) {
				return h("div", { style: STYLE.wrap }, [
					h("p", { style: STYLE.note }, "这个插件行还没有被宿主暴露为可编辑配置项（settings namespace 未就绪）。"),
				]);
			}

			if (snapshot?.status === "loading") {
				return h("div", { style: STYLE.wrap }, [h("p", { style: STYLE.note }, "配置加载中……")]);
			}

			if (snapshot?.status === "unavailable") {
				return h("div", { style: STYLE.wrap }, [
					h("p", { style: STYLE.note }, "宿主没有暴露这个插件行的配置命名空间，无法在页面上编辑。"),
				]);
			}

			const statusLine = (() => {
				if (!status) return null;
				if (status.state === "saving") return "保存中……";
				if (status.state === "saved") return "已保存";
				if (status.state === "rejected") return "宿主拒绝了这次写入（值可能非法）";
				return `写入失败：${status.message ?? "未知错误"}`;
			})();

			return h("div", { style: STYLE.wrap }, [
				h("p", { style: STYLE.note }, [
					"这里是 dsh-hindsight-memory 的运行配置。改完需要重启 DSH 才会生效（profile 层配置在启动时解析）。",
					h("br", null),
					"想看记忆库里的真实内容，打开 Hindsight 官方前端：",
					h("a", { href: "http://127.0.0.1:9999", target: "_blank", rel: "noreferrer" }, "http://127.0.0.1:9999"),
				]),
				...GROUPS.map((group) =>
					h("section", { key: group, style: STYLE.group }, [
						h("h4", { style: STYLE.groupTitle }, group),
						...(grouped.get(group) ?? []).map((spec) =>
							h(FieldRow, {
								key: spec.key,
								spec,
								effective: value[spec.key],
								draft: drafts[spec.key],
								onDraft,
								onSave,
								onClear,
								writable,
							}),
						),
					]),
				),
				statusLine ? h("div", { style: STYLE.status }, statusLine) : null,
			]);
		}

		/** client 侧需要的服务：slots（注册渲染槽位）。 */
		const inject = ["slots"];

		/**
		 * 注册插件行配置页。
		 * @param {any} ctx 浏览器端插件上下文。
		 */
		function apply(ctx) {
			// 行级配置页：插件包名 # bundle 里声明的行 id。
			ctx.slots.inject("plugins.row.config", () =>
				ctx.slots.register(
					{
						name: "plugins.row.config",
						key: "dsh-hindsight-memory#hindsight-memory",
						inject: () => ({}),
					},
					HindsightMemoryConfig,
				),
			);
			// 包级配置页：渲染在插件详情页的描述与行之间（仅 page 视图）。
			ctx.slots.inject("plugins.bundle.config", () =>
				ctx.slots.register(
					{
						name: "plugins.bundle.config",
						key: "dsh-hindsight-memory",
						inject: () => ({}),
					},
					HindsightMemoryConfig,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "dsh-hindsight-memory";
		return module.exports;
	},
});
