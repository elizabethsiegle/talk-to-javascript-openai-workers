const fns = {
	getPageHTML: () => {
		return { success: true, html: document.documentElement.outerHTML };
	},
	changeBackgroundColor: ({ color }) => {
		document.body.style.backgroundColor = color;
		return { success: true, color };
	},
	changeTextColor: ({ color }) => {
		document.body.style.color = color;
		return { success: true, color };
	},
	fillGiftForm: async ({ field, value }) => {
		if (field === 'submit') {
			const submitButton = document.querySelector('button[type="submit"]');
			if (submitButton) {
				submitButton.click();
				return { success: true, message: 'Form submitted' };
			} else {
				return { success: false, message: 'Submit button not found' };
			}
		}

		const element = document.getElementById(field);
		if (element) {
			element.focus();
			element.value = value;
			element.dispatchEvent(new Event('input', { bubbles: true }));
			await new Promise(resolve => setTimeout(resolve, 500));
			return { success: true, message: `Filled out ${field} with ${value}` };
		} else {
			console.error(`Element with id ${field} not found`);
			return { success: false, message: `Could not find field ${field}` };
		}
	},
};

let dataChannel = null;
let peerConnection = null;
let isConnecting = false;

async function initWebRTC() {
	console.log('Initializing WebRTC. Current state:', { 
		isConnecting,
		hasDataChannel: !!dataChannel,
		hasPeerConnection: !!peerConnection 
	});

	if (isConnecting) {
		console.log('Already connecting, aborting new connection attempt');
		return;
	}

	try {
		isConnecting = true;

		if (peerConnection) {
			console.log('Closing existing peer connection');
			peerConnection.close();
			peerConnection = null;
		}
		if (dataChannel) {
			console.log('Closing existing data channel');
			dataChannel.close();
			dataChannel = null;
		}
		//initialize a WebRTC session (including the data channel to send and receive Realtime API events). assumes you have already fetched an ephemeral API token
		console.log('Creating new peer connection');
		peerConnection = new RTCPeerConnection();

		// Create a data channel from a peer connection
		console.log('Creating new data channel');
		dataChannel = peerConnection.createDataChannel('audio', {
			ordered: true,	
		});

		dataChannel.onopen = () => {
			console.log('Data channel opened with ID:', dataChannel.id);
			
			// Add a small delay to ensure our tool registration happens after session creation
			setTimeout(() => {
				const event = {
					type: 'session.update',
					session: {
						modalities: ['text', 'audio'],
						tools: [
							{
								type: 'function',
								name: 'fillGiftForm',
								description: 'Fills out one field in the gift recommendation form or submits the form',
								parameters: {
									type: 'object',
									properties: {
										field: {
											type: 'string',
											enum: ['name', 'location', 'interests', 'movie', 'superpower', 'breakfast', 'spirit-animal', 'submit'],
											description: 'Which field to fill out, or "submit" to click the submit button'
										},
										value: {
											type: 'string',
											description: 'The value to fill in (not needed for submit action)'
										}
									},
									required: ['field']
								}
							}
						],
					},
				};
				console.log('Sending tool registration:', event);
				dataChannel.send(JSON.stringify(event));
			}, 1000);  // Wait 1 second after channel opens
		};

		dataChannel.onmessage = async (ev) => {
			console.log('Received message:', ev.data);
			const msg = JSON.parse(ev.data);
			
			if (msg.type === 'function_call') {
				console.log('Function call received:', msg);
				if (msg.function.name === 'fillGiftForm') {
					console.log('Attempting to fill form with:', msg.function.parameters);
					const params = JSON.parse(msg.function.parameters);
					const result = await fns.fillGiftForm(params);
					console.log('Fill form result:', result);
					
					const event = {
						type: 'conversation.item.create',
						item: {
							type: 'function_call_output',
							call_id: msg.function.call_id,
							output: JSON.stringify(result),
						},
					};
					console.log('Sending response:', event);
					dataChannel.send(JSON.stringify(event));
				}
			}
			
			if (msg.type === 'response.function_call_arguments.done') {
				const fn = fns[msg.name];
				if (fn !== undefined) {
					console.log(`Calling local function ${msg.name} with ${msg.arguments}`);
					const args = JSON.parse(msg.arguments);
					const result = await fn(args);
					console.log('result', result);
					const event = {
						type: 'conversation.item.create',
						item: {
							type: 'function_call_output',
							call_id: msg.call_id,
							output: JSON.stringify(result),
						},
					};
					dataChannel.send(JSON.stringify(event));
				}
			}
		};

		peerConnection.ontrack = (event) => {
			const el = document.createElement('audio');
			el.srcObject = event.streams[0];
			el.autoplay = el.controls = true;
			document.body.appendChild(el);
		};

		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		stream.getTracks().forEach((track) => peerConnection.addTransceiver(track, { direction: 'sendrecv' }));

		const offer = await peerConnection.createOffer();
		await peerConnection.setLocalDescription(offer);

		const response = await fetch('/rtc-connect', {
			method: 'POST',
			body: offer.sdp,
			headers: {
				'Content-Type': 'application/sdp',
			},
		});

		const answer = await response.text();
		await peerConnection.setRemoteDescription({
			sdp: answer,
			type: 'answer',
		});

	} catch (error) {
		console.error('WebRTC initialization failed:', error);
		throw error;
	} finally {
		isConnecting = false;
	}
}

async function cleanup() {
	console.log('Cleaning up connections');
	if (peerConnection) {
		peerConnection.close();
		peerConnection = null;
	}
	if (dataChannel) {
		dataChannel.close();
		dataChannel = null;
	}
	try {
		await fetch('/rtc-disconnect', { method: 'POST' });
	} catch (e) {
		console.error('Error disconnecting:', e);
	}
}

window.addEventListener('beforeunload', cleanup);

initWebRTC();

function fillGiftForm(field, value) {
	const form = document.getElementById('giftForm');
	if (!form) {
		console.error('Form not found');
		return;
	}

	const input = form.querySelector(`[name="${field}"]`);
	if (input) {
		input.value = value;
		// Trigger change event to update any listeners
		input.dispatchEvent(new Event('change'));
	} else {
		console.error(`Field ${field} not found`);
	}
}