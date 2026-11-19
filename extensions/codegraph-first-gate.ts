import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { indexState } from "../lib/codegraph-lease.ts";

/**
 * The persistent-memory reads the AGENTS.md Memory ordering rule gates in a prompt that has
 * searched the workspace: there they may run only after a codegraph query or explore has
 * finalized in the same user prompt.
 */
const MEMORY_READ_TOOLS = new Set(["mem_context", "mem_search", "mem_get_observation"]);

const BLOCK_REASON =
	"codegraph-first gate: persistent-memory reads during workspace-search activity come after a codegraph query or explore in the same user prompt (AGENTS.md Memory ordering). Call codegraph first - a failed or unavailable attempt also counts - then retry this memory read; prompts with no workspace search are never gated.";

/** The environment override for the gate's workspace scoping: "1" forces it on, "0" off. */
const MEMORY_GATE_OVERRIDE = "GENTLE_CODEGRAPH_MEMORY_GATE";

/**
 * The conservative bash-command sniff that marks a prompt as a workspace search: a command
 * naming rg, grep, fd, find, ag or ack as a standalone word.
 */
const SEARCH_COMMAND_SNIFF = /\b(?:rg|grep|fd|find|ag|ack)\b/;

/**
 * The bash-command sniff for the CLI query workflow AGENTS.md credits: codegraph query or
 * codegraph explore with any arguments (the worktree-dispatch form carries -p); init, status,
 * and every other subcommand never match.
 */
const CLI_QUERY_SNIFF = /\bcodegraph\s+(?:query|explore)\b/;

/**
 * Whether the Memory ordering gate applies to the workspace a memory read runs in: only a
 * workspace that actually has a codegraph index pays the rule, so an unindexed project's memory
 * reads pass with zero graph involvement — the presence probe is a filesystem stat of
 * .codegraph/codegraph.db, never a codegraph call, so machines without the CLI are never blocked
 * either. GENTLE_CODEGRAPH_MEMORY_GATE wins both ways: "1" forces the gate on without an index,
 * "0" turns it off with one; any other value defers to the index. The probe re-runs per call, so
 * an index created mid-session starts gating at the next read. Any error — or a host ctx without
 * a cwd — fails open like every guard here: the gate can never break a tool call.
 */
function gateApplies(cwd: unknown): boolean {
	const override = process.env[MEMORY_GATE_OVERRIDE];
	if (override === "1") return true;
	if (override === "0") return false;
	try {
		return typeof cwd === "string" && indexState(cwd) === "present";
	} catch {
		return false;
	}
}

/**
 * Per-prompt codegraph-first gate (AGENTS.md Memory ordering), scoped to workspace-search
 * prompts: persistent-memory reads (mem_context, mem_search, mem_get_observation) are blocked
 * once the prompt has searched the workspace — a grep, find or ls tool execution, or a bash
 * command naming rg, grep, fd, find, ag or ack — until a codegraph query or explore has
 * finalized in the same user prompt; a graph execution in flight blocks memory reads
 * regardless, so a read never interleaves a live graph call. The CLI query workflow (a
 * bash-run codegraph query or explore) counts as that query or explore, start to end. The
 * gate is also batch-aware: an assistant turn whose tool batch mixes a memory read with a
 * graph query or explore never admits the memory read, whichever position lists it — a
 * batch's admitted calls run concurrently, so order inside it cannot satisfy the rule. A prompt with no workspace
 * search is never gated: its memory reads pass with zero graph involvement. The requested
 * operation is tracked from the call's start — an init completion never credits. Credit is
 * end-of-execution only — a failed or unavailable query or explore counts — and, like the
 * prompt's search-activity marker, expires with every new user prompt, whether that prompt
 * starts a run or is delivered as steering or a queued follow-up inside a running loop;
 * credit applies only to a fully settled window:
 * while any graph execution is still active, or when a new graph call starts after credit
 * was granted, memory reads stay blocked. The gate is scoped: it applies only to workspaces
 * that have a codegraph index — a filesystem probe of the database file, never a CLI call —
 * with GENTLE_CODEGRAPH_MEMORY_GATE=1 forcing it on and =0 off, so an unindexed workspace's
 * memory reads pass with no graph involvement at all. The guard is total: any internal
 * error allows the call, so the gate can never break a tool call. *
 * Wired through pi's extension-directory discovery (discoverAndLoadExtensions over
 * extensions/); no manifest entry is needed — the runtime-harness EXTENSIONS list is
 * banner-test-specific, not a wiring manifest.
 */
export default function codegraphFirstGate(pi: ExtensionAPI): void {
	// Credit lives in this activation only and expires with every user prompt.
	let credited = false;
	// Whether this prompt has searched the workspace: a grep, find or ls tool execution, or a
	// bash command naming a search tool. The gate bites memory reads only in such prompts.
	let searchActivity = false;
	// The graph executions that started but have not finalized: one call's completion must not
	// credit the prompt while a sibling call is still running, and a graph call that starts after
	// credit was granted re-opens the window until it finalizes.
	const activeGraphExecutions = new Set<string>();
	// The query/explore executions pending finalization, by call id: the end event carries no
	// arguments, so the requested operation is recorded here when the call starts.
	const queryExploreExecutions = new Set<string>();
	// Whether the current assistant turn's tool batch mixes a persistent-memory read with a
	// graph query or explore: such a batch's memory reads are refused at admission, because Pi
	// runs a batch's admitted calls concurrently — order inside the batch cannot satisfy the
	// codegraph-first rule.
	let batchMixesMemoryWithGraph = false;
	/** codegraph tool calls count for the window: the session tool and the MCP proxy surface. */
	const isGraphToolName = (toolName: unknown): boolean =>
		toolName === "codegraph" || (typeof toolName === "string" && toolName.startsWith("mcp__codegraph__"));
	/** Whether a graph tool call requested a query or an explore: the session tool reports the
	 * operation in its args; the MCP proxy surface encodes it in the tool name. Anything else —
	 * init, a malformed or hostile payload — never credits. */
	const isQueryOrExplore = (toolName: unknown, args: unknown): boolean => {
		if (toolName === "codegraph") {
			const operation = (args as { operation?: unknown } | undefined | null)?.operation;
			return operation === "query" || operation === "explore";
		}
		return typeof toolName === "string" && (toolName.endsWith("_query") || toolName.endsWith("_explore"));
	};
	/** Whether one assistant tool-call block is a graph query or explore on any credited
	 * surface: the session tool's operation, the MCP proxy's name, or the CLI query workflow
	 * through bash. */
	const isGraphQueryCall = (name: unknown, args: unknown): boolean => {
		if (typeof name !== "string") return false;
		if (isQueryOrExplore(name, args)) return true;
		const command = (args as { command?: unknown } | undefined | null)?.command;
		return name === "bash" && typeof command === "string" && CLI_QUERY_SNIFF.test(command);
	};

	/** The whole tool batch of one assistant turn, read from the turn's own message: Pi
	 * prepares and executes the batch's calls only after that message ends, so the batch
	 * composition is known before any tool_call admission. A batch that mixes a memory read
	 * with a graph query can never satisfy the ordering rule — its calls run concurrently —
	 * so the answer marks every memory read of that turn refused, whichever position lists them. */
	function batchIsMixed(message: unknown): boolean {
		const content = (message as { content?: unknown } | undefined | null)?.content;
		if (!Array.isArray(content)) return false;
		let memory = false;
		let graph = false;
		for (const block of content) {
			const call = block as { type?: unknown; name?: unknown; arguments?: unknown } | undefined | null;
			if (call?.type !== "toolCall" || typeof call.name !== "string") continue;
			if (MEMORY_READ_TOOLS.has(call.name)) memory = true;
			else if (isGraphQueryCall(call.name, call.arguments)) graph = true;
		}
		return memory && graph;
	}

	// A new user prompt starts the Memory ordering window over: codegraph must come first again.
	// before_agent_start fires once per primary request (a user prompt or sendUserMessage),
	// not per LLM turn, so credit earned in one turn of a request survives into its later turns.
	pi.on?.("before_agent_start", () => {
		credited = false;
		searchActivity = false;
		batchMixesMemoryWithGraph = false;
		activeGraphExecutions.clear();
		queryExploreExecutions.clear();
	});

	// A delivered user message starts the window over on its own: Pi (1.2.0+, which the manifest
	// permits) consumes steering and queued follow-up messages inside the running agent loop
	// without another before_agent_start, so the reset must ride the delivery event too.
	// The search-activity marker resets with the credit, so a memory-only follow-up such as
	// "now summarize what changed" is not gated by the searched prompt that came before it.
	// message_end fires for every message; a user role resets, and an assistant turn instead
	// reports its own tool batch (mixed or not) for the batch-aware admission; tool-result and
	// custom deliveries never expire credit.
	pi.on?.("message_end", (event) => {
		try {
			const role = (event as { message?: { role?: unknown } | undefined | null } | undefined | null)?.message?.role;
			if (role === "user") {
				credited = false;
				searchActivity = false;
				batchMixesMemoryWithGraph = false;
				activeGraphExecutions.clear();
				queryExploreExecutions.clear();
			} else if (role === "assistant") {
				// The turn's whole tool batch is visible here, before Pi prepares its calls: mark
				// whether it mixes memory reads with graph queries so admission can check the batch.
				batchMixesMemoryWithGraph = batchIsMixed((event as { message?: unknown } | undefined | null)?.message);
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// Start-of-execution: the graph call is now active, so no memory read may pass the gate
	// until its matching end event finalizes it (keyed by toolCallId; nested calls carry their
	// own ids too). A query or explore is also recorded as credit-worthy — the end event
	// carries no arguments, so the requested operation is captured here, hostile payload or not.
	pi.on?.("tool_execution_start", (event) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (isGraphToolName(toolName) && typeof toolCallId === "string") {
				activeGraphExecutions.add(toolCallId);
				if (isQueryOrExplore(toolName, (event as { args?: unknown }).args)) queryExploreExecutions.add(toolCallId);
			}
			// A search tool or search-shaped bash command marks the prompt as a workspace search,
			// arming the gate for its memory reads; a hostile or malformed payload never throws.
			if (toolName === "grep" || toolName === "find" || toolName === "ls") {
				searchActivity = true;
			} else if (toolName === "bash") {
				const command = ((event as { args?: { command?: unknown } | undefined | null } | undefined | null)?.args)?.command;
				if (typeof command === "string") {
					if (SEARCH_COMMAND_SNIFF.test(command)) searchActivity = true;
					// A CLI query or explore through bash is the graph execution AGENTS.md credits for
					// worktree dispatches: active from its start, credited at its end like any other,
					// and never for init, status, or another subcommand.
					if (CLI_QUERY_SNIFF.test(command) && typeof toolCallId === "string") {
						activeGraphExecutions.add(toolCallId);
						queryExploreExecutions.add(toolCallId);
					}
				}
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// End-of-execution only, for the operations the rule names: a query or explore that was
	// tracked at start credits even when it failed — the result payload is deliberately never
	// read — while an init completion (or an untracked call) never does. Liveness is kept in the
	// same guarded step: a payload hostile to one field must not void the other.
	pi.on?.("tool_execution_end", (event) => {
		try {
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (typeof toolCallId === "string") {
				activeGraphExecutions.delete(toolCallId);
				if (queryExploreExecutions.delete(toolCallId)) credited = true;
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// The gate itself: in a workspace the gate applies to, block persistent-memory reads once
	// the prompt has searched the workspace until the codegraph-first window is credited — and
	// always while a graph execution is still active or the turn's own batch mixes the read
	// with one; every guard failure (throwing payload,
	// malformed toolName, missing workspace) allows the call rather than breaking it.
	pi.on?.("tool_call", (event, ctx) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			const cwd = (ctx as { cwd?: unknown } | undefined | null)?.cwd;
			if (typeof toolName === "string" && MEMORY_READ_TOOLS.has(toolName) && gateApplies(cwd) && (activeGraphExecutions.size > 0 || batchMixesMemoryWithGraph || (searchActivity && !credited))) {
				return { block: true, reason: BLOCK_REASON };
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}
