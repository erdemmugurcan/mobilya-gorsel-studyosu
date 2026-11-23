import { getMagnificConnection } from '@/lib/magnific-mcp/auth';

// Only { connected } leaves the server; tokens stay in data/magnific-auth.json.
export async function GET(): Promise<Response> {
  try {
    const { connected } = await getMagnificConnection();
    return Response.json({ connected });
  } catch (err) {
    console.error(err);
    return Response.json({ connected: false });
  }
}
