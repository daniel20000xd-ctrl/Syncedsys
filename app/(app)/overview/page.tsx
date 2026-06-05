import { redirect } from 'next/navigation'

// The admin surface moved to /admin (the Admin Console). Keep this route as a
// redirect so existing links and bookmarks still work.
export default function OverviewPage() {
  redirect('/admin')
}
