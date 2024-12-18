import { z } from 'zod';

// Gift recommendation schema
export const GiftRecSchema = z.object({
  friendName: z.string(),
  recommendations: z.array(z.string()),
  timestamp: z.string(),
  votes: z.number().default(0)
});

export type GiftRec = z.infer<typeof GiftRecSchema>;

// Add this interface near the top with other type definitions
interface VoteRequest {
  voteType: 'up' | 'down';
  friendName: string;  // Keep as separate fields
  timestamp: string;   // Keep as separate fields
}

export class GiftListStore {
  private state: DurableObjectState;
  private history: GiftRec[] = [];

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request) {
    if (request.method === 'POST') {
      const body = await request.json() as VoteRequest;
      console.log('Received data:', body);

      // Handle voting
      if (body.voteType) {
        const { friendName, timestamp, voteType } = body;
        let gifts: GiftRec[] = await this.state.storage.get('gifts') || [];
        
        const giftIndex = gifts.findIndex(g => 
            g.friendName === friendName && g.timestamp === timestamp
        );
        
        if (giftIndex !== -1) {
            if (!gifts[giftIndex].votes) gifts[giftIndex].votes = 0;
            const voteChange = voteType === 'up' ? 1 : -1;
            gifts[giftIndex].votes = Math.max(0, gifts[giftIndex].votes + voteChange);
            
            await this.state.storage.put('gifts', gifts);
            return new Response(JSON.stringify({ votes: gifts[giftIndex].votes }));
        }
        return new Response(JSON.stringify({ error: 'Friend not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Handle new recommendations
      try {
        const data = GiftRecSchema.parse({ ...body, votes: 0 });
        let gifts: GiftRec[] = await this.state.storage.get('gifts') || [];
        gifts = [...gifts, data];
        await this.state.storage.put('gifts', gifts);
        return new Response('Saved');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return new Response(JSON.stringify({ error: `Validation error: ${errorMessage}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    if (request.method === 'DELETE') {
        await this.state.storage.deleteAll();
        return new Response('Storage cleared', { status: 200 });
    }

    // GET request
    const gifts = await this.state.storage.get('gifts') || [];
    return new Response(JSON.stringify(gifts), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

interface Env {
  GIFT_RECS_STORE: DurableObjectNamespace;
}
