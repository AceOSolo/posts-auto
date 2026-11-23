import { redirect } from 'next/navigation';

/** PLA-08 : l'inventaire fait désormais partie de la vue de la semaine. */
export default async function InventoryPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  redirect(`/planning/${workspaceId}/semaine`);
}
