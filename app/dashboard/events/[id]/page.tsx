import { redirect } from "next/navigation";

/**
 * An event's own URL — which is its room.
 *
 * The webinar follow-up email ("Open the event") and its in-app notification
 * linked here for as long as auto-share has existed, and there was no page:
 * every student who clicked "watch the recording" got a 404. The follow-up now
 * links to the room directly, and this redirect is for the links already
 * sitting in inboxes (and for anyone who trims `/live` off the URL). The room
 * page does all the authorizing — including the 404 for an event the reader
 * cannot see — and after the webinar it lists the recording and the slides
 * for whoever may have them.
 */
export default async function EventPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  redirect(`/dashboard/events/${encodeURIComponent(id)}/live`);
}
