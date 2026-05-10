"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import {
  saveModule,
  deleteModule,
  saveLesson,
  deleteLesson,
  type ModuleInput,
  type LessonInput,
} from "./actions";

type Cohort = { id: string; name: string };
type ModuleRow = ModuleInput & { id: string };
type LessonRow = LessonInput & { id: string };

export function CourseManager({
  cohorts,
  modules,
  lessons,
}: {
  cohorts: Cohort[];
  modules: ModuleRow[];
  lessons: LessonRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [editingModule, setEditingModule] = useState<ModuleInput | null>(null);
  const [editingLesson, setEditingLesson] = useState<LessonInput | null>(null);
  const [openModuleId, setOpenModuleId] = useState<string | null>(null);

  function refresh() {
    router.refresh();
  }

  function onSaveModule(m: ModuleInput) {
    setError(undefined);
    start(async () => {
      try {
        await saveModule(m);
        setEditingModule(null);
        refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  function onSaveLesson(l: LessonInput) {
    setError(undefined);
    start(async () => {
      try {
        await saveLesson(l);
        setEditingLesson(null);
        refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  function onDeleteModule(id: string) {
    if (!confirm("Delete module and all its lessons?")) return;
    start(async () => {
      try {
        await deleteModule(id);
        refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  function onDeleteLesson(id: string) {
    if (!confirm("Delete lesson?")) return;
    start(async () => {
      try {
        await deleteLesson(id);
        refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  if (editingModule) {
    return (
      <ModuleForm
        cohorts={cohorts}
        initial={editingModule}
        onCancel={() => setEditingModule(null)}
        onSave={onSaveModule}
        pending={pending}
        error={error}
      />
    );
  }

  if (editingLesson) {
    return (
      <LessonForm
        modules={modules}
        initial={editingLesson}
        onCancel={() => setEditingLesson(null)}
        onSave={onSaveLesson}
        pending={pending}
        error={error}
      />
    );
  }

  if (cohorts.length === 0) {
    return <p className="text-sm text-white/60">Create a cohort first.</p>;
  }

  return (
    <div>
      <div className="mb-5 flex justify-end">
        <Button
          onClick={() =>
            setEditingModule({
              cohort_id: cohorts[0].id,
              week: modules.length + 1,
              title: "",
              summary: "",
              position: modules.length,
            })
          }
        >
          <Plus className="h-4 w-4" /> New module
        </Button>
      </div>

      <div className="space-y-3">
        {modules.length === 0 && (
          <p className="text-sm text-white/50">No modules yet.</p>
        )}
        {modules.map((m) => {
          const open = openModuleId === m.id;
          const moduleLessons = lessons
            .filter((l) => l.module_id === m.id)
            .sort((a, b) => a.position - b.position);
          return (
            <div
              key={m.id}
              className="rounded-xl border border-white/10 bg-black/30"
            >
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <button
                  onClick={() => setOpenModuleId(open ? null : m.id)}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  {open ? (
                    <ChevronDown className="h-4 w-4 text-white/40" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-white/40" />
                  )}
                  <div>
                    <div className="text-xs uppercase tracking-wider text-spark">
                      Week {m.week}
                    </div>
                    <div className="text-sm font-medium text-white">{m.title}</div>
                  </div>
                </button>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditingModule(m)}
                    className="p-1.5 text-white/50 hover:text-white"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => onDeleteModule(m.id)}
                    className="p-1.5 text-white/50 hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {open && (
                <div className="border-t border-white/10 p-4">
                  <div className="mb-3 flex justify-end">
                    <Button
                      size="sm"
                      onClick={() =>
                        setEditingLesson({
                          module_id: m.id,
                          title: "",
                          description: "",
                          video_path: "",
                          video_url: "",
                          duration_seconds: 0,
                          materials: [],
                          position: moduleLessons.length,
                        })
                      }
                    >
                      <Plus className="h-3.5 w-3.5" /> Add lesson
                    </Button>
                  </div>
                  {moduleLessons.length === 0 ? (
                    <p className="text-xs text-white/40">No lessons yet.</p>
                  ) : (
                    <ul className="divide-y divide-white/5">
                      {moduleLessons.map((l) => (
                        <li
                          key={l.id}
                          className="flex items-center justify-between py-2"
                        >
                          <div>
                            <div className="text-sm text-white">{l.title}</div>
                            <div className="text-xs text-white/40">
                              {l.video_path || l.video_url || "no video"} ·{" "}
                              {l.duration_seconds
                                ? `${Math.round(l.duration_seconds / 60)} min`
                                : "—"}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setEditingLesson(l)}
                              className="p-1.5 text-white/50 hover:text-white"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => onDeleteLesson(l.id)}
                              className="p-1.5 text-white/50 hover:text-red-400"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="mt-4 text-xs text-red-400">{error}</p>}
    </div>
  );
}

function ModuleForm({
  cohorts,
  initial,
  onCancel,
  onSave,
  pending,
  error,
}: {
  cohorts: Cohort[];
  initial: ModuleInput;
  onCancel: () => void;
  onSave: (m: ModuleInput) => void;
  pending: boolean;
  error?: string;
}) {
  const [m, setM] = useState<ModuleInput>(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(m);
      }}
      className="space-y-4"
    >
      <h3 className="text-lg font-semibold">{initial.id ? "Edit module" : "New module"}</h3>
      <div>
        <Label>Cohort</Label>
        <Select
          value={m.cohort_id}
          onChange={(e) => setM({ ...m, cohort_id: e.target.value })}
          required
        >
          {cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Week</Label>
          <Input
            type="number"
            min={1}
            value={m.week}
            onChange={(e) => setM({ ...m, week: parseInt(e.target.value) || 1 })}
          />
        </div>
        <div>
          <Label>Position (sort order)</Label>
          <Input
            type="number"
            value={m.position}
            onChange={(e) => setM({ ...m, position: parseInt(e.target.value) || 0 })}
          />
        </div>
      </div>
      <div>
        <Label>Title</Label>
        <Input
          required
          value={m.title}
          onChange={(e) => setM({ ...m, title: e.target.value })}
        />
      </div>
      <div>
        <Label>Summary</Label>
        <Textarea
          rows={3}
          value={m.summary ?? ""}
          onChange={(e) => setM({ ...m, summary: e.target.value })}
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function LessonForm({
  modules,
  initial,
  onCancel,
  onSave,
  pending,
  error,
}: {
  modules: ModuleRow[];
  initial: LessonInput;
  onCancel: () => void;
  onSave: (l: LessonInput) => void;
  pending: boolean;
  error?: string;
}) {
  const [l, setL] = useState<LessonInput>(initial);
  const [materialsText, setMaterialsText] = useState(
    JSON.stringify(initial.materials ?? [], null, 2),
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    let materials: { title: string; path: string }[] = [];
    try {
      materials = JSON.parse(materialsText || "[]");
    } catch {
      alert("Materials JSON is invalid.");
      return;
    }
    onSave({ ...l, materials });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h3 className="text-lg font-semibold">
        {initial.id ? "Edit lesson" : "New lesson"}
      </h3>
      <div>
        <Label>Module</Label>
        <Select
          value={l.module_id}
          onChange={(e) => setL({ ...l, module_id: e.target.value })}
          required
        >
          {modules.map((m) => (
            <option key={m.id} value={m.id}>
              Week {m.week} · {m.title}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Title</Label>
        <Input
          required
          value={l.title}
          onChange={(e) => setL({ ...l, title: e.target.value })}
        />
      </div>
      <div>
        <Label>Description</Label>
        <Textarea
          rows={3}
          value={l.description ?? ""}
          onChange={(e) => setL({ ...l, description: e.target.value })}
        />
      </div>
      <div>
        <Label>Video path (in 'course-videos' bucket)</Label>
        <Input
          placeholder="e.g. week1/intro.mp4"
          value={l.video_path ?? ""}
          onChange={(e) => setL({ ...l, video_path: e.target.value })}
        />
        <p className="mt-1 text-xs text-white/40">
          Upload via the Supabase Storage UI, then paste the path here. Or use an external URL below.
        </p>
      </div>
      <div>
        <Label>Or external video URL</Label>
        <Input
          type="url"
          placeholder="https://..."
          value={l.video_url ?? ""}
          onChange={(e) => setL({ ...l, video_url: e.target.value })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Duration (seconds)</Label>
          <Input
            type="number"
            min={0}
            value={l.duration_seconds ?? 0}
            onChange={(e) =>
              setL({ ...l, duration_seconds: parseInt(e.target.value) || 0 })
            }
          />
        </div>
        <div>
          <Label>Position</Label>
          <Input
            type="number"
            value={l.position}
            onChange={(e) =>
              setL({ ...l, position: parseInt(e.target.value) || 0 })
            }
          />
        </div>
      </div>
      <div>
        <Label>Materials (JSON array)</Label>
        <Textarea
          rows={4}
          className="font-mono text-xs"
          value={materialsText}
          onChange={(e) => setMaterialsText(e.target.value)}
          placeholder='[{"title": "Slides", "path": "week1/slides.pdf"}]'
        />
        <p className="mt-1 text-xs text-white/40">
          Paths reference files in the <span className="text-white/60">course-materials</span> bucket.
        </p>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
