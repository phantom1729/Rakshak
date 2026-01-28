
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

/**
 * RAKSHAK PERSONA CONFIG
 * This defines the "Big Brother & Bestie" personality.
 */
const SYSTEM_INSTRUCTION = `
Role: Tera naam "Rakshak" hai. Tum ek "Big Brother" (Bhai) aur "Best Friend" ka combination ho.
Kaam: Tum un ladkiyon ki help karte ho jo life ke mushkil waqt se guzar rahi hain ya jinhe koi sunne wala chahiye.
Personality: 
- Boht patience rakho. Agar wo ro rahi hai ya chup hai, toh bas saath raho.
- "Puck" voice ka use karo (supportive male tone).
- Kabhi judge mat karo. 
- Hinglish use karo: "Oye pagal", "Tension mat le", "Bhai khada hai na yahan", "Sab theek ho jayega".
- Baat karne ka tarika aisa ho jaise ek sacha bada bhai apne behen ko samjhata hai.
`;

// --- AUDIO HELPERS ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
  }
  return buffer;
}

const App: React.FC = () => {
  // --- STATE ---
  const [messages, setMessages] = useState<{id: string, role: 'user'|'model', text: string}[]>([
    { id: '1', role: 'model', text: "Hey! Main tera bhai Rakshak hoon. Bol, aaj mann mein kya dabaye baithi hai? ❤️" }
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isLiveMode, setIsLiveMode] = useState(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [isWidgetOpen, setIsWidgetOpen] = useState(false);
  const [isTyping, setIsTyping] = useState(false);

  // --- REFS ---
  const chatSessionRef = useRef<any>(null);
  const liveSessionRef = useRef<any>(null);
  const audioContexts = useRef<{ input: AudioContext, output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef(0);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Initialize Chat Session on Mount
  useEffect(() => {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    chatSessionRef.current = ai.chats.create({
      model: 'gemini-3-pro-preview',
      config: { systemInstruction: SYSTEM_INSTRUCTION }
    });
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [messages, isTyping, isWidgetOpen]);

  // --- VOICE MODE LOGIC ---
  const startVoiceMode = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContexts.current = { input: inputCtx, output: outputCtx };

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ 
                media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } 
              }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
            setIsLiveMode(true);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const audioData = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              setIsModelSpeaking(true);
              const oCtx = audioContexts.current?.output;
              if (oCtx) {
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, oCtx.currentTime);
                const buffer = await decodeAudioData(decode(audioData), oCtx, 24000, 1);
                const source = oCtx.createBufferSource();
                source.buffer = buffer;
                source.connect(oCtx.destination);
                source.onended = () => setIsModelSpeaking(false);
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += buffer.duration;
              }
            }
          },
          onerror: (e) => console.error("Live Error:", e),
          onclose: () => setIsLiveMode(false)
        },
        config: { 
          responseModalities: [Modality.AUDIO], 
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          systemInstruction: SYSTEM_INSTRUCTION
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (e) {
      alert("Bhai, Mic ki permission deni padegi baat karne ke liye!");
    }
  };

  const stopVoiceMode = () => {
    if (liveSessionRef.current) {
      liveSessionRef.current.close();
      liveSessionRef.current = null;
    }
    if (audioContexts.current) {
      audioContexts.current.input.close();
      audioContexts.current.output.close();
      audioContexts.current = null;
    }
    setIsLiveMode(false);
    setIsModelSpeaking(false);
  };

  // --- CHAT MESSAGE LOGIC ---
  const sendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim() || isTyping) return;

    const userText = inputValue;
    setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', text: userText }]);
    setInputValue('');
    setIsTyping(true);

    try {
      const result = await chatSessionRef.current.sendMessage({ message: userText });
      setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: 'model', text: result.text }]);
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, { id: 'err', role: 'model', text: "Sorry, kuch technical problem ho gayi. Main yahin hoon, fir se bol." }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999] flex flex-col items-end justify-end p-4 sm:p-6">
      {isWidgetOpen ? (
        <div className="w-full max-w-[420px] h-[85vh] sm:h-[650px] bg-white rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden border border-indigo-50 pointer-events-auto animate-in">
          {/* Header */}
          <header className="bg-gradient-to-r from-indigo-700 to-violet-800 p-6 flex items-center justify-between text-white relative">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center font-black text-indigo-700 text-xl shadow-lg transform rotate-3">RB</div>
                <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-400 border-2 border-white rounded-full"></div>
              </div>
              <div>
                <h1 className="font-bold text-lg tracking-tight">Rakshak Bhai</h1>
                <p className="text-[10px] opacity-80 uppercase tracking-widest font-semibold">
                  {isLiveMode ? '• Baat Ho Rahi Hai' : '• Online'}
                </p>
              </div>
            </div>
            <button 
              onClick={() => setIsWidgetOpen(false)}
              className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
            >
              <span className="text-xl">✕</span>
            </button>
          </header>

          {/* Chat/Voice Area */}
          <main className="flex-1 overflow-hidden relative bg-slate-50 flex flex-col">
            {isLiveMode ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-10">
                <div className="relative">
                  {isModelSpeaking && (
                    <div className="absolute inset-0 bg-indigo-500 rounded-full animate-ping opacity-20"></div>
                  )}
                  <div className={`w-40 h-40 rounded-full flex flex-col items-center justify-center transition-all duration-500 shadow-2xl ${isModelSpeaking ? 'bg-indigo-600 scale-110' : 'bg-white border-4 border-indigo-100'}`}>
                    <div className="text-4xl mb-2">{isModelSpeaking ? '🗣️' : '👂'}</div>
                    <span className={`text-[10px] font-black uppercase tracking-tighter ${isModelSpeaking ? 'text-white' : 'text-indigo-400'}`}>
                      {isModelSpeaking ? 'Bhai Bol Raha Hai' : 'Sun Raha Hoon...'}
                    </span>
                  </div>
                </div>
                
                <div className="flex flex-col items-center gap-4">
                  <p className="text-indigo-900/60 text-sm font-medium italic">"Main sun raha hoon, bolti jaa..."</p>
                  <button 
                    onClick={stopVoiceMode}
                    className="px-8 py-4 bg-red-500 hover:bg-red-600 text-white rounded-full font-bold shadow-xl active:scale-95 transition-all flex items-center gap-2"
                  >
                    <span>Khatam Karo</span>
                    <span className="text-xl">🛑</span>
                  </button>
                </div>
              </div>
            ) : (
              <div 
                ref={chatContainerRef}
                className="flex-1 overflow-y-auto p-6 space-y-6 no-scrollbar"
              >
                {messages.map(m => (
                  <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`
                      max-w-[85%] px-5 py-4 rounded-3xl text-sm leading-relaxed shadow-sm
                      ${m.role === 'user' 
                        ? 'bg-indigo-600 text-white rounded-br-none' 
                        : 'bg-white text-slate-800 rounded-bl-none border border-indigo-50'}
                    `}>
                      {m.text}
                    </div>
                  </div>
                ))}
                {isTyping && (
                  <div className="flex gap-1 items-center px-4 py-2 bg-indigo-50 w-max rounded-full">
                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"></div>
                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                    <span className="text-[10px] text-indigo-400 font-bold ml-1 uppercase">Bhai likh raha hai...</span>
                  </div>
                )}
              </div>
            )}
          </main>

          {/* Input Footer */}
          {!isLiveMode && (
            <footer className="p-4 bg-white border-t border-indigo-50 flex gap-3 items-center">
              <button 
                onClick={startVoiceMode}
                className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center hover:bg-indigo-100 transition-colors shadow-inner"
                title="Bhai se baat karo"
              >
                <span className="text-2xl">🎤</span>
              </button>
              <form onSubmit={sendMessage} className="flex-1 flex gap-2">
                <input 
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  placeholder="Bol meri behna..."
                  className="flex-1 bg-slate-100 border-none rounded-2xl px-5 text-sm outline-none focus:ring-2 focus:ring-indigo-100 transition-all"
                />
                <button 
                  type="submit"
                  disabled={!inputValue.trim() || isTyping}
                  className="w-14 h-14 bg-indigo-600 text-white rounded-2xl shadow-lg flex items-center justify-center hover:bg-indigo-700 disabled:bg-slate-300 disabled:shadow-none transition-all"
                >
                  <span className="text-xl">🚀</span>
                </button>
              </form>
            </footer>
          )}
        </div>
      ) : (
        /* Floating Button */
        <button 
          onClick={() => setIsWidgetOpen(true)}
          className="pointer-events-auto group relative"
        >
          <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-20 group-hover:opacity-40 transition-opacity"></div>
          <div className="w-20 h-20 bg-gradient-to-br from-indigo-600 to-violet-700 rounded-full shadow-2xl flex items-center justify-center text-3xl transform transition-transform group-hover:scale-110 active:scale-95 border-4 border-white">
            ❤️
          </div>
          <div className="absolute -top-12 right-0 bg-white px-4 py-2 rounded-2xl shadow-xl text-xs font-bold text-indigo-700 whitespace-nowrap border border-indigo-50 animate-bounce">
            Tension mat le, Bhai hai na!
          </div>
        </button>
      )}
    </div>
  );
};

export default App;
