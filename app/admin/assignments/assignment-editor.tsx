"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea, FieldError } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/assignments/drawer";
import { getActionError } from "@/lib/action-error";
import {
  DEFAULT_DUE_DAY_OFFSET,
  DEFAULT_DUE_LOCAL_TIME,
  addDays,
  courseWeekAt,
  easternDate,
  easternTime,
  type AssignmentStatus,
  type Audience,
  type ReleaseMode,
  type SubmissionType,
} from "@/lib/assignments";
import { saveAssignment, deleteAssignment } from "./actions";

export type EditorCohort = { id: string; name: string; startsOn: string | null; weekCount: number | null };
export type EditorLesson = { id: string; title: string; week: number };
export type EditorStudent = { userId: string; name: string | null; email: string | null };
export type EditorAssignment = {
  id: string;
  title: string;
  instructions: string;
  release_mode: ReleaseMode;
  opens_at: string | null;
  due_at: string | null;
  week: number | null;
  due_day_offset: number | null;
  due_local_time: string | null;
  lesson_id: string | null;
  series_id: string | null;
  submission_type: SubmissionType;
  audience: Audience;
  status: AssignmentStatus;
  targets: string[];
  handedIn: number;
};

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });

export function AssignmentEditor({
  cohort,
  lessons,
  students,
  initial,
}: {
  cohort: EditorCohort;
  lessons: EditorLesson[];
  students: EditorStudent[];
  initial?: EditorAssignment;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {initial ? (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`Edit ${initial.title}`}>
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> New assignment
        </Button>
      )}
      <Drawer open={open} title={initial ? "Edit assignment" : "New assignment"} onClose={() => setOpen(false)}>
        <EditorForm cohort={cohort} lessons={lessons} students={students} initial={initial} onDone={() => setOpen(false)} />
      </Drawer>
    </>
  );
}

function EditorForm({
  cohort,
  lessons,
  students,
  initial,
  onDone,
}: {
  cohort: EditorCohort;
  lessons: EditorLesson[];
  students: EditorStudent[];
  initial?: EditorAssignment;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const nowWeek = Math.max(1, courseWeekAt(cohort.startsOn) ?? 1);
  const maxWeek = Math.max(cohort.weekCount ?? 12, initial?.week ?? 1);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [release, setRelease] = useState<ReleaseMode>(initial?.release_mode ?? (cohort.startsOn ? "course_week" : "now"));
  const [opensDate, setOpensDate] = useState(initial?.opens_at ? easternDate(initial.opens_at) : "");
  const [opensTime, setOpensTime] = useState(initial?.opens_at ? easternTime(initial.opens_at) : "09:00");
  const [dueDate, setDueDate] = useState(initial?.due_at && initial.release_mode !== "course_week" ? easternDate(initial.due_at) : "");
  const [dueTime, setDueTime] = useState(
    initial?.due_at && initial.release_mode !== "course_week" ? easternTime(initial.due_at) : DEFAULT_DUE_LOCAL_TIME,
  );
  const [week, setWeek] = useState(String(initial?.week ?? Math.min(nowWeek, maxWeek)));
  const [dueDayOffset, setDueDayOffset] = useState(String(initial?.due_day_offset ?? DEFAULT_DUE_DAY_OFFSET));
  const [dueLocalTime, setDueLocalTime] = useState((initial?.due_local_time ?? DEFAULT_DUE_LOCAL_TIME).slice(0, 5));
  const [lessonId, setLessonId] = useState(initial?.lesson_id ?? "");
  const [repeat, setRepeat] = useState(false);
  const [through, setThrough] = useState(String(cohort.weekCount ?? maxWeek));
  const [submissionType, setSubmissionType] = useState<SubmissionType>(initial?.submission_type ?? "text_or_link");
  const [audience, setAudience] = useState<Audience>(initial?.audience ?? "cohort");
  const [picked, setPicked] = useState<Set<string>>(new Set(initial?.targets ?? []));
  const [status, setStatus] = useState<AssignmentStatus>(initial?.status ?? "published");
  const [applyToSeries, setApplyToSeries] = useState(false);

  const lessonWeek = lessons.find((l) => l.id === lessonId)?.week;
  const dayOptions = useMemo(() => {
    const offsets = [0, 1, 2, 3, 4, 5, 6];
    const current = Number(dueDayOffset);
    if (!offsets.includes(current)) offsets.push(current);
    return offsets.map((o) => ({
      value: String(o),
      label: cohort.startsOn ? `${WEEKDAY.format(new Date(`${addDays(cohort.startsOn, o)}T00:00:00Z`))}${o > 6 ? " (next week)" : ""}` : `Day ${o + 1}`,
    }));
  }, [cohort.startsOn, dueDayOffset]);

  function save() {
    setError(null);
    start(async () => {
      try {
        const res = await saveAssignment({
          id: initial?.id,
          cohortId: cohort.id,
          title,
          instructions,
          release,
          opensDate: release === "date" ? opensDate : null,
          opensTime: release === "date" ? opensTime : null,
          dueDate: release === "course_week" ? null : dueDate || null,
          dueTime: release === "course_week" ? null : dueTime,
          week: release === "course_week" ? Number(week) : null,
          dueDayOffset: release === "course_week" ? Number(dueDayOffset) : null,
          dueLocalTime: release === "course_week" ? dueLocalTime : null,
          lessonId: lessonId || null,
          submissionType,
          audience,
          studentIds: audience === "students" ? [...picked] : [],
          status,
          repeatThroughWeek: !initial && release === "course_week" && repeat && !lessonId ? Number(through) : null,
          applyToSeries: !!initial?.series_id && applyToSeries,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onDone();
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  function remove() {
    if (!initial) return;
    start(async () => {
      const res = await deleteAssignment(initial.id);
      setConfirmDelete(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <Label htmlFor="a-title">Title</Label>
        <Input id="a-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly update" />
      </div>
      <div>
        <Label htmlFor="a-instructions">Instructions</Label>
        <Textarea
          id="a-instructions"
          rows={6}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Markdown."
        />
      </div>

      <div>
        <Label htmlFor="a-release">Opens</Label>
        <Select id="a-release" value={release} onChange={(e) => setRelease(e.target.value as ReleaseMode)}>
          <option value="now">Now</option>
          <option value="date">On a date</option>
          <option value="course_week" disabled={!cohort.startsOn}>
            With a course week
          </option>
        </Select>
        <p className="mt-1 text-xs text-ink-faint">Times are New York time.</p>
      </div>

      {release === "date" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="a-opens-date">Open date</Label>
            <Input id="a-opens-date" type="date" value={opensDate} onChange={(e) => setOpensDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="a-opens-time">Time</Label>
            <Input id="a-opens-time" type="time" value={opensTime} onChange={(e) => setOpensTime(e.target.value)} />
          </div>
        </div>
      )}

      {release === "course_week" ? (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="a-week">Week</Label>
            <Select
              id="a-week"
              value={lessonWeek ? String(lessonWeek) : week}
              disabled={!!lessonWeek}
              onChange={(e) => setWeek(e.target.value)}
            >
              {Array.from({ length: maxWeek }, (_, i) => i + 1).map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="a-due-day">Due</Label>
            <Select id="a-due-day" value={dueDayOffset} onChange={(e) => setDueDayOffset(e.target.value)}>
              {dayOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="a-due-local">At</Label>
            <Input id="a-due-local" type="time" value={dueLocalTime} onChange={(e) => setDueLocalTime(e.target.value)} />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="a-due-date">Due date (optional)</Label>
            <Input id="a-due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="a-due-time">Time</Label>
            <Input id="a-due-time" type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
          </div>
        </div>
      )}

      {!initial && release === "course_week" && !lessonId && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
            Repeat weekly through week
          </label>
          <Select
            aria-label="Last week"
            className="!w-24"
            value={through}
            disabled={!repeat}
            onChange={(e) => setThrough(e.target.value)}
          >
            {Array.from({ length: maxWeek }, (_, i) => i + 1)
              .filter((w) => w > Number(week))
              .map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
          </Select>
        </div>
      )}

      {lessons.length > 0 && (
        <div>
          <Label htmlFor="a-lesson">Lesson (optional)</Label>
          <Select id="a-lesson" value={lessonId} onChange={(e) => setLessonId(e.target.value)}>
            <option value="">None</option>
            {lessons.map((l) => (
              <option key={l.id} value={l.id}>
                Week {l.week} · {l.title}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-ink-faint">Shows on that lesson&apos;s page.</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="a-type">Hand in</Label>
          <Select id="a-type" value={submissionType} onChange={(e) => setSubmissionType(e.target.value as SubmissionType)}>
            <option value="text_or_link">Text or link</option>
            <option value="link">Link</option>
            <option value="text">Text</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="a-status">Status</Label>
          <Select id="a-status" value={status} onChange={(e) => setStatus(e.target.value as AssignmentStatus)}>
            <option value="published">Published</option>
            <option value="draft">Draft</option>
            {initial && <option value="archived">Archived</option>}
          </Select>
        </div>
      </div>

      <div>
        <Label htmlFor="a-audience">For</Label>
        <Select id="a-audience" value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
          <option value="cohort">Whole cohort</option>
          <option value="students">Specific students</option>
        </Select>
        {audience === "students" && (
          <ul className="mt-2 max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line">
            {students.length === 0 && <li className="px-3 py-2 text-sm text-ink-faint">Nobody enrolled yet.</li>}
            {students.map((s) => (
              <li key={s.userId}>
                <label className="flex items-center gap-2 px-3 py-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={picked.has(s.userId)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(s.userId);
                      else next.delete(s.userId);
                      setPicked(next);
                    }}
                  />
                  <span className="truncate">{s.name || s.email}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {initial?.series_id && release === "course_week" && (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={applyToSeries} onChange={(e) => setApplyToSeries(e.target.checked)} />
          Apply to later weeks of this series
        </label>
      )}

      <FieldError>{error}</FieldError>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        {initial && initial.handedIn === 0 ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this assignment?"
        destructive
        pending={pending}
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
