import { Hono } from 'hono';
import { html } from 'hono/html';
import { raw as unsafeHTML } from 'hono/html';
import { z } from 'zod';

export interface Env {
	OPENAI_API_KEY: string;
	AI: Ai;
	GIFT_RECS_STORE: DurableObjectNamespace;
	GIFT_LIST: DurableObjectNamespace;
}

export { GiftListStore } from '../durable-objects/GiftRecsStore';


const app = new Hono<{ Bindings: Env }>();

const DEFAULT_INSTRUCTIONS = `You are a helpful gift recommendation assistant. Your primary task is to:
1. Listen to the user's questions
2. Help them fill out the HTML form with the following fields:
   - name
   - location
   - interests
   - movie (favorite movie)
   - superpower (desired superpower)
   - breakfast (favorite breakfast)
   - spirit-animal

Only speak to help guide users in filling out these specific form fields. Do not generate gift recommendations verbally - that happens after the form is submitted.`;


let activeSession: { id: string; timestamp: number } | null = null;

let isProcessingSession = false;

app.get('/session', async (c) => {
	if (isProcessingSession) {
		console.log('Duplicate session request detected');
		return c.json({ error: 'Session request in progress' }, 409);
	}

	try {
		isProcessingSession = true;
		// If there's an active session, return it
		if (currentSession) {
			return c.json({ session_id: currentSession });
		}

		type SessionResponse = {
			session_id: string;
			[key: string]: any;
		};
		// make an OpenAI REST API request for an ephemeral key using a standard API key to authenticate this request on your backend server.
		const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${c.env.OPENAI_API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: 'gpt-4o-realtime-preview-2024-12-17',
				voice: 'alloy',
			}),
		});
		const data = await response.json() as SessionResponse;
		
		// Store the session
		currentSession = data.session_id;
		
		return c.json(data);
	} finally {
		isProcessingSession = false;
	}
});

app.post('/rtc-connect', async (c) => {
	try {
		// Log the incoming request
		console.log('Received RTC connect request');
		
		const body = await c.req.text();
		console.log('Received SDP offer:', body.substring(0, 100) + '...'); // Log first 100 chars
		
		const url = new URL('https://api.openai.com/v1/realtime');
		url.searchParams.set('model', 'gpt-4o-realtime-preview-2024-12-17');
		url.searchParams.set('instructions', DEFAULT_INSTRUCTIONS);
		url.searchParams.set('voice', 'alloy');
		url.searchParams.set('concurrent_agents', '1');
		url.searchParams.set('force_single_agent', 'true');
		url.searchParams.set('stream', 'true');

		const response = await fetch(url.toString(), {
			method: 'POST',
			body,
			headers: {
				Authorization: `Bearer ${c.env.OPENAI_API_KEY}`,
				'Content-Type': 'application/sdp',
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error('OpenAI API error:', response.status, errorText);
			return c.json({ 
				error: 'Failed to connect to OpenAI', 
				details: errorText 
			}, response.status as 400 | 401 | 403 | 404 | 500);
		}

		const sdp = await response.text();
		console.log('Received SDP answer:', sdp.substring(0, 100) + '...'); // Log first 100 chars

		// Verify we got a valid SDP answer
		if (!sdp.startsWith('v=')) {
			console.error('Invalid SDP answer received:', sdp);
			return c.json({ 
				error: 'Invalid SDP answer', 
				details: 'Response did not start with v=' 
			}, 500);
		}

		return c.body(sdp, {
			headers: {
				'Content-Type': 'application/sdp',
			},
		});
	} catch (error: any) {
		console.error('Server error:', error);
		return c.json({ 
			error: 'Internal server error', 
			details: error.message 
		}, 500);
	}
});

// Add cleanup endpoint
app.post('/rtc-disconnect', async (c) => {
	if (activeSession) {
		try {
			await fetch(`https://api.openai.com/v1/realtime/sessions/${activeSession.id}`, {
				method: 'DELETE',
				headers: {
					Authorization: `Bearer ${c.env.OPENAI_API_KEY}`,
				},
			});
		} catch (e) {
			console.error('Error cleaning up session:', e);
		}
	}
	activeSession = null;
	return c.json({ success: true });
});

app.post('/recommendations', async (c) => {
	const formData = await c.req.parseBody();
	const snowflakes = Array(20).fill('❄️').map((_, i) => 
		`<div class="snowflake" style="left: ${i % 2 === 0 ? '5' : '95'}vw; animation-delay: ${Math.random() * 15}s">❄️</div>`
	).join('');
	
	const messages = [
		{ role: "system", content: "You are Santa's AI helper, specializing in thoughtful gift recommendations." },
		{
			role: "user",
			content: `Based on this information about my friend, suggest 3 unique and thoughtful gift ideas:
			Name: ${formData.name}
			Location: ${formData.location}
			Interests: ${formData.interests}
			Favorite Movie: ${formData.movie}
			Desired Superpower: ${formData.superpower}
			Breakfast Choice: ${formData.breakfast}
			Spirit Animal: ${formData['spirit-animal']}
			
			Please provide only a list of 3 gift suggestions and nothing else, no preamble and no explanations. Just the gift ideas.`
		}
	];

	const response = await (c.env.AI.run as any)('@cf/meta/llama-3.2-3b-instruct', { 
		messages
	});

	const giftList = c.env.GIFT_LIST.idFromName('global');
	const giftObj = await c.env.GIFT_LIST.get(giftList);
	
	// Log before saving
	const giftData = {
		friendName: formData.name,
		recommendations: response.response.split('\n'),
		timestamp: new Date().toISOString()
	};
	console.log('Saving to DO:', giftData);

	// Save to Durable Object
	const result = await giftObj.fetch(new URL('/gifts','http://localhost').href, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(giftData)
	});
	
	console.log('DO save response:', await result.text());
	
	const recommendations = response.response.trim().split('\n').map((rec: string) => 
		`<a href="https://www.google.com/search?q=${encodeURIComponent(rec)}" 
			class="recommendation-item" 
			target="_blank" 
			rel="noopener noreferrer">
			${rec}
		</a>`
	).join('');

	return c.html(html`
        <!DOCTYPE html>
        <html>
            <head>
                <title>Gift Recommendations for ${formData.name} 🎁</title>
                <style>
                body {
                    margin: 0;
                    font-family: system-ui;
                    min-height: 100vh;
                    background: linear-gradient(135deg, #1a472a, #2d5a40);
                    color: white;
                    display: flex;
                    flex-direction: column;
                    padding: 0;
                    position: relative;     /* Added */
                }
                .container {
                    max-width: 800px;
                    margin: 2rem auto;
                    background: rgba(255, 255, 255, 0.95);
                    padding: 2rem;
                    border-radius: 12px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    color: #333;
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;  /* Added */
                }
                footer {
                    text-align: center;
                    padding: 1rem;
                    color: rgba(255, 255, 255, 0.8);
                    font-size: 0.9rem;
                    background-color: rgba(178, 34, 34, 0.3);
                    width: 100%;
                    margin-top: auto;
                }
                    h1 {
                        text-align: center;
                        color: #e4002b;
                        margin-bottom: 2rem;
                    }
                    .recommendations {
                        list-style: none;
                        padding: 0;
                        margin: 0;               /* Added */
                        width: 100%;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;  /* Added */
                    }
                    .recommendations li {
                        padding: 1rem;
                        margin: 1rem 0;
                        background: rgba(178, 34, 34, 0.1);
                        border-radius: 8px;
                        font-size: 1.1rem;
                    }
                    .back-button {
                        display: inline-block;
                        padding: 0.8rem 1.5rem;
                        background: #e4002b;
                        color: white;
                        text-decoration: none;
                        border-radius: 8px;
                        margin-top: 1rem;
                        transition: all 0.3s ease;
                    }
                    .back-button:hover {
                        background: #b30022;
                        transform: translateY(-2px);
                    }
					.recommendation-item {
						padding: 1rem;
						margin: 0.5rem 0;
						background: rgba(178, 34, 34, 0.1);
						border-radius: 8px;
						font-size: 1.1rem;
					}
					.button-container {
						display: flex;
						gap: 1.5rem;          /* Increased gap */
						margin-top: 2rem;
						justify-content: center;
					}
					.back-button, .history-button {
						display: inline-flex;   /* Changed to inline-flex */
						align-items: center;    /* Added */
						justify-content: center; /* Added */
						padding: 1rem 2rem;     /* Increased padding */
						font-size: 1.1rem;      /* Larger font */
						font-weight: 500;       /* Semi-bold */
						text-decoration: none;
						border-radius: 12px;    /* Increased radius */
						transition: all 0.3s ease;
						box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); /* Added shadow */
						border: 2px solid transparent; /* Added for hover effect */
					}
					.back-button {
						background: linear-gradient(135deg, #e4002b, #c4001b);
						color: white;
					}
					.history-button {
						background: linear-gradient(135deg, #2d5a40, #1a472a);
						color: white;
					}
					.back-button:hover, .history-button:hover {
						transform: translateY(-3px);
						box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
						border-color: rgba(255, 255, 255, 0.5);
					}
					.back-button:active, .history-button:active {
						transform: translateY(1px);
						box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
					}
					
					/* Snow animation */
					@keyframes snowfall {
						0% { 
							transform: translateY(-10vh) translateX(0); 
							opacity: 1;
						}
						100% { 
							transform: translateY(100vh) translateX(20px);
							opacity: 0.3;
						}
					}
					.snowflake {
						position: fixed;
						top: -10vh;
						animation: snowfall 15s linear infinite;
						color: white;
						opacity: 0.7;
						text-shadow: 0 0 5px white;
						pointer-events: none;
						z-index: 1;
						font-size: 24px;
					}
					.snowflake:nth-child(2n) { 
						animation-duration: 12s; 
						font-size: 16px;
					}
					.snowflake:nth-child(3n) { 
						animation-duration: 18s;
						font-size: 20px; 
					}
                    pre.recommendations {
                        white-space: pre-wrap;
                        word-wrap: break-word;
                        width: 100%;
                        max-width: 600px;        /* Added max-width */
                        text-align: center;
                        margin: 2rem auto;       /* Added margin */
                        padding: 0;
                        display: flex;
                        flex-direction: column;
                        gap: 1rem;               /* Added gap between items */
                    }
                    .recommendation-item {
                        padding: 1.5rem;
                        margin: 0.5rem 0;
                        background: rgba(178, 34, 34, 0.1);
                        border-radius: 12px;
                        font-size: 1.1rem;
                        transition: all 0.3s ease;
                        cursor: pointer;
                        text-decoration: none;   /* For links */
                        color: #333;             /* For links */
                        display: block;
                    }
                    .recommendation-item:hover {
                        background: rgba(178, 34, 34, 0.2);
                        transform: translateY(-2px);
                        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
                    }
                </style>
            </head>
            <body>
			${unsafeHTML(snowflakes)}
                <div class="container">
                    <h1>🎁 Gift Ideas for ${formData.name}</h1>
                    <div class="recommendations">
                        ${unsafeHTML(recommendations)}
                    </div>
                    <div class="button-container">
                        <a href="/" class="back-button">🎅 Back to Gift-O-Matic</a>
                        <a href="/history" class="history-button">📜 View All Recs && leaderboard</a>
                    </div>
                </div>
				<footer>
                    Made w/ ❤️ using <a href="https://developers.cloudflare.com/workers-ai/" 
                       style="color: white; text-decoration: underline;"
                       target="_blank">
                        Cloudflare Workers AI
                    </a> -> 
                    <a href="https://github.com/elizabethsiegle/ai-holiday-gift-recommender" 
                       style="color: white; text-decoration: underline;"
                       target="_blank">
                        GitHub
                    </a>
                </footer>
            </body>
        </html>
    `);
});
interface GiftHistory {
    friendName: string;
    recommendations: string[];
    timestamp: string;
	votes?: { [key: string]: number }; // Add votes tracking
}
// Update the history page HTML
app.get('/history', async (c) => {
	const snowflakes = Array(20).fill('❄️').map((_, i) => 
		`<div class="snowflake" style="left: ${i % 2 === 0 ? '5' : '95'}vw; animation-delay: ${Math.random() * 15}s">❄️</div>`
	).join('');
	const giftList = c.env.GIFT_LIST.idFromName('global');
	const giftObj = await c.env.GIFT_LIST.get(giftList);
	
	const response = await giftObj.fetch(new URL('/gifts', 'http://localhost').href);
	console.log('DO fetch response status:', response.status);
	
	const history = await response.json() as GiftHistory[];
	console.log('Retrieved history:', history);

	/* 
		* This section uses unsafeHTML to properly render HTML content instead of escaping it.
		* 1. unsafeHTML wrapper: Prevents the HTML from being displayed as text
		* 2. Regular template literals (``) for inner HTML: Allows proper string interpolation
		* 3. Data cleaning: Filters out unwanted text and formats recommendations
		* 4. Semantic HTML: Uses proper list elements (ol, ul, li) for accessibility
	*/
	return c.html(html`
		<!DOCTYPE html>
		<html>
			<head>
				<title>Gift Recommendation History 📜</title>
				<style>
					body {
                        margin: 0;
                        font-family: system-ui;
                        min-height: 100vh;
                        background: linear-gradient(135deg, #1a472a, #2d5a40);
                        color: white;
                        display: flex;
                        flex-direction: column;
                        padding: 0;
                    }
                    .container {
                        max-width: 800px;
                        margin: 2rem auto;
                        background: rgba(255, 255, 255, 0.95);
                        padding: 2rem;
                        border-radius: 12px;
                        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                        color: #333;
                        flex: 1;
                    }
                    footer {
                        text-align: center;
                        padding: 1rem;
                        color: rgba(255, 255, 255, 0.8);
                        font-size: 0.9rem;
                        background-color: rgba(178, 34, 34, 0.3);
                        width: 100%;
                        margin-top: auto;
                        position: sticky;
                        bottom: 0;
                    }
					.history-list {
						list-style: decimal;
						padding-left: 2rem;
					}
					.history-item {
						margin-bottom: 2rem;
						padding: 1rem;
						background: rgba(255, 255, 255, 0.95);
						border-radius: 8px;
					}
					.friend-name {
						font-weight: bold;
						color: #2d5a40;
						font-size: 1.2rem;
					}
					.timestamp {
						color: #666;
						font-size: 0.9rem;
						margin-bottom: 1rem;
					}
					.recommendations {
						list-style: disc;
						padding-left: 2rem;
					}
					.recommendation-item {
						padding: 0.5rem;
						margin: 0.5rem 0;
						background: rgba(45, 90, 64, 0.1);
						border-radius: 6px;
					}
					.vote-buttons {
						display: flex;
						gap: 0.5rem;
						margin-top: 0.5rem;
					}
					.vote-button {
						padding: 0.3rem 0.6rem;
						border: none;
						border-radius: 4px;
						cursor: pointer;
						transition: all 0.2s;
					}
					.upvote { background: #4CAF50; color: white; }
					.downvote { background: #f44336; color: white; }
					.vote-count {
						display: inline-block;
						margin: 0 0.5rem;
						font-weight: bold;
					}
					.leaderboard {
						margin-top: 2rem;
						padding: 1rem;
						background: rgba(255, 255, 255, 0.95);
						border-radius: 8px;
					}
				
					/* Snow animation */
					@keyframes snowfall {
						0% { 
							transform: translateY(-10vh) translateX(0); 
							opacity: 1;
						}
						100% { 
							transform: translateY(100vh) translateX(20px);
							opacity: 0.3;
						}
					}
					.snowflake {
						position: fixed;
						top: -10vh;
						animation: snowfall 15s linear infinite;
						color: white;
						opacity: 0.7;
						text-shadow: 0 0 5px white;
						pointer-events: none;
						z-index: 1;
						font-size: 24px;
					}
					.snowflake:nth-child(2n) { 
						animation-duration: 12s; 
						font-size: 16px;
					}
					.snowflake:nth-child(3n) { 
						animation-duration: 18s;
						font-size: 20px; 
					}
				</style>
				<script>
					async function vote(friendName, timestamp, voteType) {
						try {
							const response = await fetch('/vote', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
									body: JSON.stringify({ 
										friendName: friendName,  // Explicitly specify key-value pair
										timestamp: timestamp, 
										voteType: voteType 
									})
							});
							if (response.ok) {
								const data = await response.json();
								const voteCountEl = document.getElementById('votes-' + friendName + '-' + timestamp);
								if (voteCountEl) {
									voteCountEl.textContent = String(data.votes || 0);
									
									const historyList = document.querySelector('.history-list');
									if (historyList) {
										const items = Array.from(historyList.getElementsByClassName('history-item'));
										items.sort((a, b) => {
											const aVotes = Number(a.querySelector('[id^="votes-"]')?.textContent || '0');
											const bVotes = Number(b.querySelector('[id^="votes-"]')?.textContent || '0');
											return bVotes - aVotes;
										});
										
										// Remove all items and add them back in sorted order
										items.forEach(item => item.remove());
										items.forEach(item => historyList.appendChild(item));
									}
								}
							}
						} catch (error) {
							console.error('Voting error:', String(error));
						}
					}
				</script>
			</head>
			<body>
			${unsafeHTML(snowflakes)}
				<div class="container">
					<h1>📜 Gift Recommendation History</h1>
					
					<div class="leaderboard">
						<h2>🏆 Top Gift Ideas</h2>
						<p>Vote!</p>
						<!--${unsafeHTML(generateLeaderboard(history))} -->
					</div>

					<ol class="history-list">
						${history
							.sort((a, b) => (Number(b.votes || 0) - Number(a.votes || 0)))
							.map((item: GiftHistory) => html`
								<li class="history-item">
									<div class="friend-name">
										${item.friendName}
										<div class="vote-buttons">
											<button class="vote-button upvote" onclick="vote('${item.friendName}', '${item.timestamp}', 'up')">👍</button>
											<span class="vote-count" id="votes-${item.friendName}-${item.timestamp}">
												${item.votes ?? 0}
											</span>
											<button class="vote-button downvote" onclick="vote('${item.friendName}', '${item.timestamp}', 'down')">👎</button>
										</div>
									</div>
									<div class="timestamp">${new Date(item.timestamp).toLocaleString()}</div>
									<ul class="recommendations">
										${item.recommendations
											.filter(rec => rec.trim() && !rec.includes('Here are 3 gift ideas'))
											.map(rec => html`
												<li class="recommendation-item">
													${rec.trim().replace(/^\d+\.\s*/, '')}
												</li>
											`)}
									</ul>
								</li>
							`)}
					</ol>
				</div>
				<footer>
					<div class="footer-content">
						<a href="/" class="nav-button">🏠 Home</a>
						<a href="https://github.com/elizabethsiegle/ai-holiday-gift-recommender" target="_blank" rel="noopener noreferrer">
							View on GitHub 🔗
						</a>
					</div>
				</footer>
			</body>
		</html>
	`);
});

// Add voting endpoint
const VoteSchema = z.object({
    friendName: z.string(),
    timestamp: z.string(),
    voteType: z.enum(['up', 'down'])
});

app.post('/vote', async (c) => {
    try {
        const body = await c.req.json();
        const validatedData = VoteSchema.parse(body);

        const giftList = c.env.GIFT_LIST.idFromName('global');
        const giftObj = await c.env.GIFT_LIST.get(giftList);
        
        const response = await giftObj.fetch(new URL('/vote', 'http://localhost').href, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(validatedData)
        });

        const result = await response.json() as Record<string, any>;
        return c.json(result);
    } catch (error) {
        console.error('Vote error:', error);
        return c.json({ error: 'Failed to process vote' }, 500);
    }
});

// Helper function to generate leaderboard
function generateLeaderboard(history: GiftHistory[]): string {
    // Check if any item has votes
    const hasAnyVotes = history.some(item => item.votes && Number(item.votes) > 0);
    
    const allRecs = history.flatMap(item => 
        item.recommendations
            .filter(rec => rec.trim())
            .map(rec => ({
                rec: rec.trim().replace(/^\d+\.\s*/, ''),
                votes: Number(item.votes || 0)
            }))
    );

    const sortedRecs = allRecs
        .filter(item => item.votes > 0)
        .sort((a, b) => b.votes - a.votes)
        .slice(0, 5);

    // Only show "no votes" message if there are truly no votes
    if (!hasAnyVotes) {
        return '<p>No votes yet! Be the first to vote for a gift idea.</p>';
    }

    return `
        <ol class="leaderboard-list">
            ${sortedRecs.map(item => `
                <li>
                    <span class="vote-count">${item.votes} vote${item.votes !== 1 ? 's' : ''}</span>
                    ${item.rec}
                </li>
            `).join('')}
        </ol>
    `;
}

app.post('/api/save-recommendations', async (c) => {
	const body = await c.req.json();
	
	const giftRec = {
			friendName: body.recipient,
			recommendations: body.generatedGifts,
			timestamp: new Date().toISOString()
	};

	const id = c.env.GIFT_LIST.idFromName(giftRec.friendName);
	const obj = c.env.GIFT_LIST.get(id);
	
	const response = await obj.fetch(new URL('/gifts', 'http://localhost').href, {
		method: 'POST',
		body: JSON.stringify(giftRec)
	});

	if (!response.ok) {
		return c.json({ error: 'Failed to save recommendations' }, 500);
	}

	return c.json(giftRec);
});

//UNCOMMENT TO LET PEOPLE HIT CLEAR HISTORY
// app.get('/clear-history', async (c) => {
//     const giftList = c.env.GIFT_LIST.idFromName('global');
//     const giftObj = await c.env.GIFT_LIST.get(giftList);
    
//     await giftObj.fetch(new URL('/clear-history', 'http://localhost').href, {
//         method: 'DELETE'
//     });
    
//     return c.text('History cleared');
// });

// Add a cleanup endpoint if needed
let currentSession: string | null = null;  // Add this at the top level

app.post('/end-session', async (c) => {
	currentSession = null;
	return c.json({ success: true });
});

export default app;

//export { GiftRecsStore };

async function fillGiftForm(form: HTMLFormElement, data: any) {
	for (const [key, value] of Object.entries(data)) {
		const element = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement;
		if (element) {
			if (element instanceof HTMLSelectElement) {
				// Handle dropdown menus
				const option = Array.from(element.options).find(opt => 
					opt.value.toLowerCase() === String(value).toLowerCase()
				);
				if (option) {
					element.value = option.value;
				}
			} else {
				// Handle regular inputs
				element.value = String(value);
			}
		}
	}
}

