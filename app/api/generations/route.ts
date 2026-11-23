import { listGenerations } from '@/lib/storage/history';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await listGenerations());
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Geçmiş yüklenirken bir hata oluştu.' }, { status: 500 });
  }
}
