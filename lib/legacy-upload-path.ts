/**
 * Whether a path from the retired upload tables (student_files,
 * team_drive_files, pitch_submissions.deck_path/video_path) may be signed for
 * download: inside its owner's folder (`<user or team id>/…`) with no
 * traversal. Those rows were once insertable through the API with any path,
 * so a row alone proves nothing. Pure, so it is unit-tested.
 */
export function legacyPathOk(path: string | null | undefined, ownerId: string): path is string {
  return (
    typeof path === "string" &&
    ownerId.length > 0 &&
    path.startsWith(`${ownerId}/`) &&
    path.length > ownerId.length + 1 &&
    !path.includes("..") &&
    !path.includes("//") &&
    !path.includes("\\")
  );
}
