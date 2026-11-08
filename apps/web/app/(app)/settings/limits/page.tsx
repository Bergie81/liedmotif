import { redirect } from 'next/navigation';

export default function LimitsPage() {
  redirect('/settings/generation#cost-controls');
}
