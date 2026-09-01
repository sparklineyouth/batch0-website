import { TemplateEditor } from "../template-editor";
import type { TemplateInput } from "../actions";

export const metadata = { title: "New email template · Admin" };
export const dynamic = "force-dynamic";

/**
 * A new template starts with a greeting already in the body rather than an
 * empty box. It's the one line every email has, it demonstrates the merge-tag
 * syntax without a doc, and it means the preview pane has something to show
 * from the first render.
 */
const BLANK: TemplateInput = {
  key: "",
  name: "",
  description: "",
  category: "custom",
  subject: "",
  preheader: "",
  bodyHtml: "<p>Hi {{first_name}},</p><p></p>",
  ctaLabel: "",
  ctaUrl: "",
  fromName: "",
  fromEmail: "",
  replyTo: "",
  variables: [
    { key: "first_name", label: "First name", example: "Alex" },
  ],
  enabled: true,
};

export default function NewEmailTemplatePage() {
  return <TemplateEditor initial={BLANK} isSystem={false} />;
}
