export type Role =
  | "student"
  | "admin"
  | "mentor"
  | "investor";

export type ApplicationStatus =
  | "draft"
  | "submitted"
  | "accepted"
  | "rejected"
  | "paid"
  | "enrolled"
  | "withdrawn";

export type Theme = "dark" | "light";

export type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  stripe_customer_id: string | null;
  referral_code: string | null;
  ai_context: Record<string, any> | null;
  theme: Theme;
  discord_user_id: string | null;
  discord_username: string | null;
  discord_avatar: string | null;
  discord_linked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ChargeKind = "fee" | "fine";
export type ChargeStatus =
  | "pending"
  | "paid"
  | "waived"
  | "cancelled"
  | "refunded";

export type UserCharge = {
  id: string;
  user_id: string;
  kind: ChargeKind;
  amount_cents: number;
  description: string;
  status: ChargeStatus;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  waived_at: string | null;
  waived_by: string | null;
  waiver_reason: string | null;
  refunded_at: string | null;
  refunded_by: string | null;
  refund_reason: string | null;
  stripe_refund_id: string | null;
};

export type Cohort_Slug = { slug: string };

export type Notification = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

export type StudentCheckin = {
  id: string;
  user_id: string;
  cohort_id: string | null;
  week_start: string;
  accomplished: string | null;
  next_up: string | null;
  blockers: string | null;
  created_at: string;
  updated_at: string;
};

export type CheckinFeedback = {
  id: string;
  checkin_id: string;
  author_id: string;
  body: string;
  created_at: string;
};

export type Resource = {
  id: string;
  cohort_id: string | null;
  category: string;
  title: string;
  description: string | null;
  storage_path: string | null;
  external_url: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  /** Visible to accepted students before their cohort starts (migration 0042). */
  pre_cohort: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditLog = {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, any> | null;
  created_at: string;
};

export type EventRow = {
  id: string;
  cohort_id: string | null;
  type: "demo_day" | "office_hours" | "workshop" | "other";
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  zoom_url: string | null;
  recording_url: string | null;
  visibility: "enrolled" | "staff" | "public";
  created_at: string;
  updated_at: string;
};

export type MentorAssignment = {
  id: string;
  mentor_id: string;
  student_id: string;
  cohort_id: string | null;
  notes: string | null;
  created_at: string;
};

export type TeamLogoStatus = "pending" | "approved" | "rejected";

export type Team = {
  id: string;
  cohort_id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  logo_url: string | null;
  logo_status: TeamLogoStatus;
  logo_rejected_reason: string | null;
  pitch_video_url: string | null;
  pitch_deck_url: string | null;
  website_url: string | null;
  is_public: boolean;
  creator_id: string | null;
  created_at: string;
  updated_at: string;
};

export type TeamInviteStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled";

export type TeamInvite = {
  id: string;
  team_id: string;
  invitee_id: string;
  invited_by: string;
  status: TeamInviteStatus;
  message: string | null;
  created_at: string;
  responded_at: string | null;
};

export type TeamDriveFile = {
  id: string;
  team_id: string;
  uploader_id: string | null;
  name: string;
  path: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
};

export type TeamMessageKind = "member" | "mentor" | "investor" | "admin";

export type TeamMessage = {
  id: string;
  team_id: string;
  author_id: string;
  body: string;
  kind: TeamMessageKind;
  created_at: string;
};

export type PitchSubmission = {
  team_id: string;
  cohort_id: string | null;
  deck_path: string | null;
  video_path: string | null;
  video_url: string | null;
  notes: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PitchScore = {
  id: string;
  team_id: string;
  scorer_id: string;
  problem: number | null;
  traction: number | null;
  team_score: number | null;
  ask: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type IntroRequestStatus =
  | "requested"
  | "intro_made"
  | "meeting_held"
  | "committed"
  | "wired"
  | "passed";

export type IntroRequest = {
  id: string;
  investor_id: string;
  team_id: string;
  status: IntroRequestStatus;
  message: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
};

export type MentorSlot = {
  id: string;
  mentor_id: string;
  starts_at: string;
  ends_at: string;
  zoom_url: string | null;
  notes: string | null;
  created_at: string;
};

export type MentorBookingStatus = "booked" | "cancelled" | "completed";

export type MentorBooking = {
  id: string;
  slot_id: string;
  student_id: string;
  topic: string | null;
  status: MentorBookingStatus;
  created_at: string;
};

export type Certificate = {
  id: string;
  user_id: string;
  cohort_id: string;
  code: string;
  issued_at: string;
};

export type TeamMember = {
  id: string;
  team_id: string;
  user_id: string;
  role: string;
  created_at: string;
};

export type InvestorInterestLevel =
  | "watching"
  | "interested"
  | "committed"
  | "passed";

export type InvestorInterest = {
  id: string;
  investor_id: string;
  team_id: string;
  level: InvestorInterestLevel;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type LessonComment = {
  id: string;
  lesson_id: string;
  user_id: string;
  parent_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
};

export type AiConversation = {
  id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type AiMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
};

export type Cohort = {
  id: string;
  name: string;
  starts_on: string | null;
  ends_on: string | null;
  capacity: number;
  status: "upcoming" | "active" | "completed" | "cancelled";
  price_cents: number;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  created_at: string;
};

export type Application = {
  id: string;
  user_id: string;
  cohort_id: string | null;
  status: ApplicationStatus;
  full_name: string | null;
  age: number | null;
  grade: string | null;
  school: string | null;
  city: string | null;
  country: string | null;
  parent_email: string | null;
  why_join: string | null;
  startup_idea: string | null;
  experience: string | null;
  hours_per_week: number | null;
  team_size: number | null;
  referral_source: string | null;
  linkedin_url: string | null;
  resume_url: string | null;
  portfolio_url: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_notes: string | null;
  paid_at: string | null;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  ai_score: number | null;
  ai_summary: string | null;
  ai_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Module = {
  id: string;
  cohort_id: string | null;
  week: number;
  title: string;
  summary: string | null;
  position: number;
  created_at: string;
};

export type Lesson = {
  id: string;
  module_id: string;
  title: string;
  description: string | null;
  video_path: string | null;
  video_url: string | null;
  duration_seconds: number | null;
  materials: { title: string; path: string }[];
  position: number;
  created_at: string;
};

export type StudentFile = {
  id: string;
  user_id: string;
  name: string;
  path: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
};

export type Payment = {
  id: string;
  user_id: string;
  application_id: string | null;
  cohort_id: string | null;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  amount_cents: number;
  currency: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  created_at: string;
};
