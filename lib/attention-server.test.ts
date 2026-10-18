import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { capabilitiesFrom } from "./permissions.ts";

// The real providers in lib/attention-server.ts against doubles of the
// sources they read, to pin what the Overview's attention list asks for and
// for whom: a source's permission decides whether it's read at all, rows
// come from a scope that can't see confidential tickets while the count is
// the viewer's own queue, and each count is the one its page shows.

type Call = { fn: string; args: any[] };
const state: {
  calls: Call[];
  missing: Set<string>;
  /** Sources whose read fails for a reason other than a missing table. */
  broken: Set<string>;
  countsAvailable: boolean;
  tickets: any[];
  ticketTotal: number;
  needsReply: number;
  reports: any[];
  feedback: any[];
  feedbackTotal: number;
  dueFollowUps: any[];
  dueTotal: number;
  /** #help's open questions (0110), as lib/chat-questions.ts would load them. */
  questions: any[];
  questionTotal: number;
} = {
  calls: [],
  missing: new Set(),
  broken: new Set(),
  countsAvailable: true,
  tickets: [],
  ticketTotal: 0,
  needsReply: 0,
  reports: [],
  feedback: [],
  feedbackTotal: 0,
  dueFollowUps: [],
  dueTotal: 0,
  questions: [],
  questionTotal: 0,
};
const MISSING = { code: "PGRST205", message: "Could not find the table in the schema cache" };
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
const record = (fn: string, args: any[]) => state.calls.push({ fn, args });

/** Just enough of supabase-js for mentorsOf() (empty) and the open-report count. */
const db = {
  from(table: string) {
    const chain: any = {
      select: () => chain,
      in: () => chain,
      eq: () => chain,
      limit: () => chain,
      then: (ok: any) => {
        record(`db:${table}`, []);
        if (table === "chat_reports" && state.missing.has("chat")) {
          return Promise.resolve({ data: null, count: null, error: MISSING }).then(ok);
        }
        if (table === "mentor_assignments" && state.broken.has("mentors")) {
          return Promise.resolve({ data: null, count: null, error: TIMEOUT }).then(ok);
        }
        if (table === "mentor_assignments" && state.feedback.length) {
          return Promise.resolve({ data: [], count: null, error: null }).then(ok);
        }
        const count = table === "chat_reports" ? state.reports.length : null;
        return Promise.resolve({ data: [], count, error: null }).then(ok);
      },
    };
    return chain;
  },
};

(globalThis as any).__attention = {
  db,
  state,
  record,
  MISSING,
};

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__attention;";
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/support":
        g +
        `export const listTicketsForStaff=async(f,s)=>{t.record('listTicketsForStaff',[f,s]);
           if(t.state.missing.has('support'))return{tickets:[],total:0,page:1,pageSize:8,error:t.MISSING};
           return{tickets:t.state.tickets,total:t.state.ticketTotal,page:1,pageSize:8,error:null};};
         export const countTicketsForStaff=async(s,f,now)=>{t.record('countTicketsForStaff',[s,f,now]);
           return t.state.countsAvailable?{needs_reply:t.state.needsReply,available:true}:{needs_reply:0,available:false};};`,
      "@/lib/chat":
        g +
        `export const getChatViewer=async(u)=>{t.record('getChatViewer',[u]);throw new Error('the whole membership was resolved');};
         export const listReports=async()=>{t.record('listReports',[]);throw new Error('listReports needs a full viewer');};
         export const listOpenReportsFor=async(u,c)=>{t.record('listOpenReportsFor',[u]);
           if(t.state.missing.has('chat')){const e=new Error("Couldn't load reports: relation does not exist");e.code='42P01';throw e;}
           return t.state.reports;};
         export const getChannelRow=async(id)=>{t.record('getChannelRow',[id]);return{id,kind:'channel',name:'help'};};`,
      "@/lib/assignments-server":
        g +
        `export const loadFeedbackQueue=async(a,scope,o)=>{t.record('loadFeedbackQueue',[scope,o]);
           if(t.state.broken.has('feedback'))return{ready:false,failed:true,total:0,items:[]};
           if(t.state.missing.has('feedback'))return{ready:false,failed:false,total:0,items:[]};
           return{ready:true,failed:false,total:t.state.feedbackTotal,items:t.state.feedback};};`,
      "@/lib/mentor-scope":
        g + "export const mentorScope=async(a,id)=>{t.record('mentorScope',[id]);return{cohortIds:['c1'],studentIds:[]};};",
      "@/lib/chat-questions":
        g +
        `export const loadUnansweredQuestions=async(o)=>{t.record('loadUnansweredQuestions',[o]);
           if(t.state.broken.has('questions'))throw new Error('statement timeout');
           if(t.state.missing.has('questions'))return{ready:false,total:0,help:null,rows:[]};
           return{ready:true,total:t.state.questionTotal,help:{id:'help-id',name:'help'},rows:t.state.questions};};`,
      "@/lib/student-followups-server":
        g +
        `export const listDueFollowUps=async(a)=>{t.record('listDueFollowUps',[a]);
           if(t.state.broken.has('followups'))return{ready:false,failed:true,total:0,rows:[]};
           if(t.state.missing.has('followups'))return{ready:false,failed:false,total:0,rows:[]};
           return{ready:true,failed:false,total:t.state.dueTotal,rows:t.state.dueFollowUps};};`,
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { loadAttention } = await import("./attention-server.ts");

const ME = "00000000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-10-17T16:00:00.000Z");
const caps = (...p: string[]) => capabilitiesFrom("custom", p);
const called = () => state.calls.map((c) => c.fn).filter((f) => !f.startsWith("db:"));
const call = (fn: string) => state.calls.find((c) => c.fn === fn);

function reset() {
  state.calls = [];
  state.missing = new Set();
  state.broken = new Set();
  state.countsAvailable = true;
  state.tickets = [];
  state.ticketTotal = 0;
  state.needsReply = 0;
  state.reports = [];
  state.feedback = [];
  state.feedbackTotal = 0;
  state.dueFollowUps = [];
  state.dueTotal = 0;
  state.questions = [];
  state.questionTotal = 0;
}

const ticket = (id: string) => ({
  id,
  reference: "B0-2345-6789",
  subject: `Request ${id}`,
  needsReply: true,
  priority: "normal",
  sensitive: false,
  requesterActivityAt: "2026-10-17T10:00:00.000Z",
  assignedTo: null,
  assignedName: null,
});

test("a viewer who can only open Student progress reads follow-ups and nothing else", async () => {
  reset();
  state.dueFollowUps = [
    { id: "f1", studentId: "u1", studentName: "Ada", ownerId: ME, ownerName: "Sam", nextCheckOn: "2026-10-17", status: "open" },
  ];
  state.dueTotal = 1;
  const r = await loadAttention({ userId: ME, caps: caps("people.view"), now: NOW });
  assert.deepEqual(called(), ["listDueFollowUps"]);
  assert.deepEqual(call("listDueFollowUps")!.args[0], { today: "2026-10-17", limit: 8 });
  assert.deepEqual(r.sources.map((s) => [s.key, s.total, s.href]), [["followups", 1, "/admin/progress#follow-ups"]]);
  assert.deepEqual(r.rows.map((x) => x.key), ["followups:f1"]);
});

test("a role with no attention source reads nothing at all", async () => {
  reset();
  const r = await loadAttention({ userId: ME, caps: caps("payments.view", "applications.view"), now: NOW });
  assert.deepEqual(state.calls, []);
  assert.deepEqual(r, { sources: [], rows: [], failed: [] });
});

test("support rows come from a scope that can't see confidential requests; the count is the viewer's queue", async () => {
  reset();
  state.tickets = [ticket("t1"), ticket("t2")];
  state.ticketTotal = 5;
  state.needsReply = 7;
  const r = await loadAttention({ userId: ME, caps: caps("support.view", "support.manage", "support.sensitive"), now: NOW });
  const [filter, listedScope] = call("listTicketsForStaff")!.args;
  assert.deepEqual(filter, { view: "needs_reply", pageSize: 8 });
  assert.deepEqual(listedScope, { userId: ME, canView: true, canManage: true, canSeeSensitive: false });
  assert.equal(call("countTicketsForStaff")!.args[0].canSeeSensitive, true, "the count uses the viewer's own scope");
  const support = r.sources.find((s) => s.key === "support")!;
  assert.equal(support.total, 7, "the Support tab's Needs reply for this person");
  assert.equal(support.note?.text, "2 confidential requests need a reply. They're listed in Support only.");
  assert.deepEqual(r.rows.map((x) => x.key), ["support:t1", "support:t2"]);
});

test("without support.sensitive there is nothing confidential to count, and no note", async () => {
  reset();
  state.tickets = [ticket("t1")];
  state.ticketTotal = 3;
  const r = await loadAttention({ userId: ME, caps: caps("support.view"), now: NOW });
  assert.equal(call("countTicketsForStaff"), undefined);
  const support = r.sources.find((s) => s.key === "support")!;
  assert.equal(support.total, 3);
  assert.equal(support.note, null);
  assert.equal(r.rows[0].action.label, "Open", "read-only support opens, it doesn't answer");
});

test("chat reports: the open queue's own count, its oldest rows", async () => {
  reset();
  // listReports answers newest first.
  state.reports = Array.from({ length: 10 }, (_, i) => ({
    id: `r${10 - i}`,
    channelId: "ch1",
    partyIds: [],
    messageId: "m",
    status: "open",
    createdAt: new Date(NOW - (10 - i) * 3_600_000).toISOString(),
  })).reverse();
  const r = await loadAttention({ userId: ME, caps: caps("chat.manage"), now: NOW });
  assert.deepEqual(call("listOpenReportsFor")!.args, [ME]);
  // Not the moderator's whole chat membership (thousands of DMs for staff)
  // on every Overview render: lib/chat-server.test.ts pins what it reads.
  assert.equal(call("getChatViewer"), undefined);
  assert.equal(call("listReports"), undefined);
  const chat = r.sources.find((s) => s.key === "chat_reports")!;
  assert.equal(chat.total, 10);
  assert.equal(chat.items.length, 8);
  assert.ok(!chat.items.some((x) => x.key === "chat_reports:r1" || x.key === "chat_reports:r2"), "the two newest wait their turn");
});

test("chat reports: with none open, the moderator's chat membership isn't even resolved", async () => {
  reset();
  const r = await loadAttention({ userId: ME, caps: caps("chat.manage"), now: NOW });
  assert.equal(call("getChatViewer"), undefined);
  assert.equal(call("listOpenReportsFor"), undefined);
  assert.deepEqual(r.sources.map((s) => [s.key, s.total]), [["chat_reports", 0], ["chat_questions", 0]]);
});

test("feedback: program-wide for assignments.manage, the mentor's own scope otherwise", async () => {
  reset();
  state.feedbackTotal = 4;
  await loadAttention({ userId: ME, caps: caps("assignments.manage"), now: NOW });
  assert.equal(call("mentorScope"), undefined);
  assert.equal(call("loadFeedbackQueue")!.args[0], null);

  reset();
  const r = await loadAttention({ userId: ME, caps: caps("mentor.panel", "people.view"), now: NOW });
  assert.deepEqual(call("mentorScope")!.args, [ME]);
  assert.deepEqual(call("loadFeedbackQueue")!.args[0], { cohortIds: ["c1"], studentIds: [] });
  assert.equal(r.sources.find((s) => s.key === "feedback")!.href, "/mentor/assignments");
});

test("a feedback or follow-up read that fails for any other reason is named under the list, not dropped", async () => {
  reset();
  state.broken = new Set(["feedback", "followups"]);
  const r = await loadAttention({ userId: ME, caps: caps("*"), now: NOW });
  assert.deepEqual([...r.failed].sort(), ["feedback", "followups"]);
  assert.ok(!r.sources.some((s) => s.key === "feedback" || s.key === "followups"));
  // A people.view-only viewer: the section stays, saying it couldn't load,
  // rather than vanishing as if nothing were due.
  reset();
  state.broken = new Set(["followups"]);
  const only = await loadAttention({ userId: ME, caps: caps("people.view"), now: NOW });
  assert.deepEqual(only, { sources: [], rows: [], failed: ["followups"] });
});

test("feedback: a failed mentor read fails the source rather than calling everyone 'Any reviewer'", async () => {
  reset();
  state.broken = new Set(["mentors"]);
  state.feedback = [
    { id: "s1", assignmentId: "a1", userId: "u1", submittedAt: "2026-10-16T10:00:00.000Z", late: false, assignment: { title: "Weekly update", week: 2, cohortId: "c1" }, studentName: "Ada" },
  ];
  state.feedbackTotal = 1;
  const r = await loadAttention({ userId: ME, caps: caps("assignments.manage"), now: NOW });
  assert.deepEqual(r.failed, ["feedback"]);
  assert.deepEqual(r.rows, []);
});

test("feedback: a manager without mentor.panel is sent to the list on /admin/assignments that shows the same count", async () => {
  reset();
  state.feedbackTotal = 3;
  const r = await loadAttention({ userId: ME, caps: caps("assignments.manage"), now: NOW });
  assert.equal(r.sources.find((s) => s.key === "feedback")!.href, "/admin/assignments#waiting-feedback");
});

test("support: support.manage without support.view reads nothing — its rows would bounce off /admin/support", async () => {
  reset();
  state.tickets = [ticket("t1")];
  state.ticketTotal = 1;
  const r = await loadAttention({ userId: ME, caps: caps("support.manage"), now: NOW });
  assert.equal(call("listTicketsForStaff"), undefined);
  assert.deepEqual(r, { sources: [], rows: [], failed: [] });
});

test("support: when the confidential count can't be read, the list says so instead of passing off a partial total", async () => {
  reset();
  state.tickets = [ticket("t1")];
  state.ticketTotal = 1;
  state.countsAvailable = false;
  const r = await loadAttention({ userId: ME, caps: caps("support.view", "support.sensitive"), now: NOW });
  const support = r.sources.find((s) => s.key === "support")!;
  assert.equal(support.total, 1);
  assert.match(support.note!.text, /Couldn't count confidential requests/);
});

test("chat reports: one the moderator filed is counted with the queue but left for someone else", async () => {
  reset();
  state.reports = [
    { id: "r2", channelId: "ch1", partyIds: [], reporterId: ME, messageId: "m", status: "open", createdAt: "2026-10-17T12:00:00.000Z" },
    { id: "r1", channelId: "ch1", partyIds: [], reporterId: "someone-else", messageId: "m", status: "open", createdAt: "2026-10-17T11:00:00.000Z" },
  ];
  const r = await loadAttention({ userId: ME, caps: caps("chat.manage"), now: NOW });
  const chat = r.sources.find((s) => s.key === "chat_reports")!;
  assert.equal(chat.total, 2, "the same number /admin/chat shows");
  assert.deepEqual(chat.items.map((x) => x.key), ["chat_reports:r1"]);
  assert.equal(chat.note?.text, "A report you filed is left for another moderator.");
});

test("a source whose migration hasn't run is left out, not reported as failing", async () => {
  reset();
  state.missing = new Set(["support", "chat", "feedback", "followups", "questions"]);
  const r = await loadAttention({ userId: ME, caps: caps("*"), now: NOW });
  assert.deepEqual(r, { sources: [], rows: [], failed: [] });
});

test("opening the attention list sends nothing: no notification, email, SMS or chat module is reachable", () => {
  const files = [
    "lib/attention.ts",
    "lib/attention-server.ts",
    "components/admin/attention-list.tsx",
    "lib/student-followups-server.ts",
    "app/admin/progress/actions.ts",
    "lib/chat-questions.ts",
  ];
  for (const f of files) {
    const src = readFileSync(path.join(root, f), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) {
      // Every module in this codebase that delivers something to a person.
      assert.doesNotMatch(
        spec,
        /^@\/lib\/(notifications|email\/|sms|chat-notify|chat-post)|^(resend|nodemailer)$/,
        `${f} imports ${spec}`,
      );
    }
    assert.doesNotMatch(src, /\bnotify(Many)?\(|sendTemplated\(|sendEmail\(|\.insert\(\s*\{[^}]*notifications/, f);
  }
});

test("unanswered questions (0110): chat staff only; #help's count; rows open their thread, and one with an open help request is Support's", async () => {
  reset();
  const q = (id: string, over: object = {}) => ({
    rootId: id, channelId: "help-id", channelName: "help", askerName: "Maya", askedAt: "2026-10-16T10:00:00.000Z", replyCount: 0, help: null, ...over,
  });
  state.questions = [
    q("q1"),
    q("q2", { replyCount: 2 }),
    q("q3", { help: { status: "open", assigneeName: "Rish" } }),
    // The team replied in Support (waiting on the asker): in no queue, so a row here.
    q("q4", { replyCount: 1, help: { status: "waiting_on_requester", assigneeName: "Rish" } }),
  ];
  state.questionTotal = 4;
  // Nobody without chat.manage reads it at all.
  await loadAttention({ userId: ME, caps: caps("support.view", "people.view"), now: NOW });
  assert.equal(call("loadUnansweredQuestions"), undefined);
  const r = await loadAttention({ userId: ME, caps: caps("chat.manage", "support.view"), now: NOW });
  assert.deepEqual(call("loadUnansweredQuestions")!.args, [{ limit: 8 }]);
  const src = r.sources.find((s) => s.key === "chat_questions")!;
  assert.equal(src.total, 4, "the number #help's Unanswered list shows");
  assert.equal(src.href, "/chat?c=help-id");
  assert.deepEqual(src.items.map((x) => x.key), ["chat_questions:q1", "chat_questions:q2", "chat_questions:q4"]);
  assert.equal(src.items[0].action.href, "/chat?c=help-id&thread=q1");
  assert.equal(src.note?.text, "1 question has a help request open: listed under Support.");
  assert.equal(src.note?.href, "/admin/support");
  // chat.manage without Support: no Support rows to leave anything to, and no note pointing at a page they can't open.
  const chatOnly = (await loadAttention({ userId: ME, caps: caps("chat.manage"), now: NOW })).sources.find((s) => s.key === "chat_questions")!;
  assert.deepEqual(chatOnly.items.map((x) => x.key), ["chat_questions:q1", "chat_questions:q2", "chat_questions:q3", "chat_questions:q4"]);
  assert.equal(chatOnly.note, null);
  // Answered questions aren't loaded, so marking one answered is what takes its row off.
  reset();
  state.questions = [];
  const none = await loadAttention({ userId: ME, caps: caps("chat.manage"), now: NOW });
  assert.equal(none.sources.find((s) => s.key === "chat_questions")!.total, 0);
  // A failed read is said, not shown as "nothing waiting"; before 0110, the source is just absent.
  reset();
  state.broken = new Set(["questions"]);
  assert.deepEqual((await loadAttention({ userId: ME, caps: caps("chat.manage"), now: NOW })).failed, ["chat_questions"]);
  reset();
  state.missing = new Set(["questions"]);
  const before = await loadAttention({ userId: ME, caps: caps("chat.manage"), now: NOW });
  assert.ok(!before.sources.some((s) => s.key === "chat_questions"));
  assert.deepEqual(before.failed, []);
});
