"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Upload,
  X,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  saveModule,
  deleteModule,
  saveLesson,
  deleteLesson,
  type ModuleInput,
  type LessonInput,
} from "./actions";
import { getUploadToken } from "./upload-actions";

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
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: "module"; id: string; title: string }
    | { kind: "lesson"; id: string; title: string }
    | null
  >(null);

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

  function executeDelete() {
    if (!confirmDelete) return;
    setError(undefined);
    const target = confirmDelete;
    start(async () => {
      try {
        if (target.kind === "module") await deleteModule(target.id);
        else await deleteLesson(target.id);
        setConfirmDelete(null);
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
    const ownerModule = modules.find((m) => m.id === editingLesson.module_id);
    return (
      <LessonForm
        modules={modules}
        cohorts={cohorts}
        initial={editingLesson}
        ownerModule={ownerModule}
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
                    aria-label="Edit module"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() =>
                      setConfirmDelete({
                        kind: "module",
                        id: m.id,
                        title: m.title,
                      })
                    }
                    className="p-1.5 text-white/50 hover:text-red-400"
                    aria-label="Delete module"
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
                              {l.video_path || l.video_url || "no video"}
                              {l.duration_seconds
                                ? ` · ${Math.round(l.duration_seconds / 60)} min`
                                : ""}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setEditingLesson(l)}
                              className="p-1.5 text-white/50 hover:text-white"
                              aria-label="Edit lesson"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() =>
                                setConfirmDelete({
                                  kind: "lesson",
                                  id: l.id,
                                  title: l.title,
                                })
                              }
                              className="p-1.5 text-white/50 hover:text-red-400"
                              aria-label="Delete lesson"
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

      <ConfirmDialog
        open={confirmDelete !== null}
        title={
          confirmDelete?.kind === "module"
            ? "Delete module?"
            : "Delete lesson?"
        }
        description={
          confirmDelete && (
            <>
              <p>
                <span className="text-white">{confirmDelete.title}</span>
                {confirmDelete.kind === "module"
                  ? " and all of its lessons will be removed."
                  : " will be removed from the course."}
              </p>
              <p className="mt-2 text-amber-300/80">This cannot be undone.</p>
            </>
          )
        }
        confirmLabel={
          confirmDelete?.kind === "module" ? "Delete module" : "Delete lesson"
        }
        destructive
        pending={pending}
        onConfirm={executeDelete}
        onCancel={() => !pending && setConfirmDelete(null)}
      />
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
      <h3 className="text-lg font-semibold">
        {initial.id ? "Edit module" : "New module"}
      </h3>
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
            onChange={(e) =>
              setM({ ...m, week: parseInt(e.target.value) || 1 })
            }
          />
        </div>
        <div>
          <Label>Position (sort order)</Label>
          <Input
            type="number"
            value={m.position}
            onChange={(e) =>
              setM({ ...m, position: parseInt(e.target.value) || 0 })
            }
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
  cohorts,
  initial,
  ownerModule,
  onCancel,
  onSave,
  pending,
  error,
}: {
  modules: ModuleRow[];
  cohorts: Cohort[];
  initial: LessonInput;
  ownerModule?: ModuleRow;
  onCancel: () => void;
  onSave: (l: LessonInput) => void;
  pending: boolean;
  error?: string;
}) {
  const [l, setL] = useState<LessonInput>(initial);
  const [materials, setMaterials] = useState<{ title: string; path: string }[]>(
    initial.materials ?? [],
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSave({ ...l, materials });
  }

  // Folder used for uploaded files: cohortname/weekN
  const m = modules.find((x) => x.id === l.module_id) ?? ownerModule;
  const cohort = cohorts.find((c) => c.id === m?.cohort_id);
  const folder = m
    ? `${cohort?.name ?? "cohort"}/week${m.week}`
    : "misc";

  return (
    <form onSubmit={submit} className="space-y-5">
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

      {/* Video upload */}
      <div className="rounded-xl border border-white/10 bg-black/30 p-4">
        <div className="mb-2 flex items-center justify-between">
          <Label className="!mb-0">Video</Label>
          {l.video_path && (
            <button
              type="button"
              className="text-xs text-white/40 hover:text-red-400"
              onClick={() => setL({ ...l, video_path: "" })}
            >
              Clear
            </button>
          )}
        </div>
        {l.video_path ? (
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white/70">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span className="font-mono">{l.video_path}</span>
          </div>
        ) : (
          <FileUploader
            bucket="course-videos"
            folder={folder}
            accept="video/*"
            onUploaded={(path) => setL({ ...l, video_path: path })}
          />
        )}
        <div className="mt-3">
          <Label>Or paste an external URL</Label>
          <Input
            type="url"
            placeholder="https://..."
            value={l.video_url ?? ""}
            onChange={(e) => setL({ ...l, video_url: e.target.value })}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Duration (seconds)</Label>
          <Input
            type="number"
            min={0}
            value={l.duration_seconds ?? 0}
            onChange={(e) =>
              setL({
                ...l,
                duration_seconds: parseInt(e.target.value) || 0,
              })
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

      {/* Materials */}
      <div className="rounded-xl border border-white/10 bg-black/30 p-4">
        <div className="mb-3 flex items-center justify-between">
          <Label className="!mb-0">Materials</Label>
        </div>
        {materials.length === 0 ? (
          <p className="mb-3 text-xs text-white/40">No materials yet.</p>
        ) : (
          <ul className="mb-3 space-y-2">
            {materials.map((mat, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2"
              >
                <Input
                  placeholder="Title"
                  value={mat.title}
                  onChange={(e) => {
                    const next = [...materials];
                    next[i] = { ...next[i], title: e.target.value };
                    setMaterials(next);
                  }}
                  className="flex-1"
                />
                <span className="font-mono text-xs text-white/40 truncate max-w-[40%]">
                  {mat.path}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setMaterials(materials.filter((_, j) => j !== i))
                  }
                  className="text-white/50 hover:text-red-400"
                  aria-label="Remove material"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <FileUploader
          bucket="course-materials"
          folder={folder}
          accept=".pdf,.doc,.docx,.ppt,.pptx,.zip,.png,.jpg,.jpeg"
          label="Upload material"
          onUploaded={(path, file) =>
            setMaterials([
              ...materials,
              { title: file?.name ?? path.split("/").pop() ?? "Material", path },
            ])
          }
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

function FileUploader({
  bucket,
  folder,
  accept,
  label = "Upload file",
  onUploaded,
}: {
  bucket: string;
  folder: string;
  accept?: string;
  label?: string;
  onUploaded: (path: string, file?: File) => void;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | undefined>();

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(undefined);
    setProgress(0);
    try {
      const { path, token } = await getUploadToken(bucket, folder, file.name);
      const supabase = createClient();
      const { error: upErr } = await supabase.storage
        .from(bucket)
        .uploadToSignedUrl(path, token, file);
      if (upErr) throw upErr;
      setProgress(100);
      onUploaded(path, file);
      // brief success flash
      setTimeout(() => setProgress(null), 600);
    } catch (err: any) {
      setError(err.message ?? String(err));
      setProgress(null);
    } finally {
      // reset input so same file can be re-picked
      e.target.value = "";
    }
  }

  return (
    <div>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs text-white/80 hover:bg-white/10">
        {progress !== null ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
        {progress !== null ? `Uploading… ${progress}%` : label}
        <input
          type="file"
          accept={accept}
          onChange={handleFile}
          className="hidden"
          disabled={progress !== null}
        />
      </label>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
