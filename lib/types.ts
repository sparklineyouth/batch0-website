export type Role = "student" | "professor" | "admin";

export type ApplicationStatus =
  | "draft"
  | "submitted"
  | "accepted"
  | "rejected"
  | "paid"
  | "enrolled"
  | "withdrawn";

export type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
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

export type Assignment = {
  id: string;
  cohort_id: string;
  lesson_id: string | null;
  title: string;
  description: string | null;
  due_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SubmissionStatus = "draft" | "submitted" | "graded";

export type AssignmentSubmission = {
  id: string;
  assignment_id: string;
  user_id: string;
  content: string | null;
  links: { title: string; url: string }[];
  files: { name: string; path: string }[];
  status: SubmissionStatus;
  submitted_at: string | null;
  grade: string | null;
  feedback: string | null;
  graded_by: string | null;
  graded_at: string | null;
  created_at: string;
  updated_at: string;
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
