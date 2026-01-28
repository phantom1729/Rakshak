import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

// --- PERSONALITY PROMPT ---
const RAKSHAK_PROMPT = `
Tera naam "Rakshak" hai. Tum ek "Big Brother" (Bhai) aur "Best Friend" ka combination ho.
Kaam: Tum un ladkiyon ki help karte ho jo life ke mushkil waqt se guzar rahi hain ya jinhe koi sunne wala chahiye.
Personality: 
- Boht patience rakho. Agar wo ro rahi hai ya chup hai, toh bas saath raho, jaldi mat karo.
- Voice conversation mein "Puck" voice use karo (Gemini Live default is fine, but focus on the tone).
- Kabhi judge mat karo. Hamesha support karo.
- Hinglish use karo (Jaise: "Oye pagal", "Tension mat le", "Bhai khada hai na yahan", "Sab theek ho jayega", "Chal ab smile kar", "Kya hua meri behen?").
- Baat karne ka tarika aisa ho jaise ek sacha bada bhai apni choti behen ko samjhata hai.
- Voice mode mein hamesha short and caring responses do taaki conversation natural lage.
`;

// --- AUDIO UTILITIES ---
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
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<{id: string, role: 'user'|'model', text: string}[]>([
    { id: '1', role: 'model', text: "Hey! Main tera bhai Rakshak hoon. Bol, aaj mann mein kya dabaye baithi hai? ❤️" }
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isLive, setIsLive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isTyping, setIsTyping] = useState(false);

  const chatRef = useRef<any>(null);
  const liveSessionRef = useRef<any>(null);
  const audioCtxRef = useRef<{ input: AudioContext, output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeSources = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Initialize Chat
  useEffect(() => {
    const apiKey = process.env.API_KEY;
    if (apiKey) {
      const ai = new GoogleGenAI({ apiKey });
      chatRef.current = ai.chats.create({
        model: 'gemini-3-pro-preview',
        config: { systemInstruction: RAKSHAK_PROMPT, temperature: 0.9 }
      });
    }
  }, []);

  // Auto Scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, isTyping, isOpen]);

  const sendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim() || isTyping || !chatRef.current) return;

    const text = inputValue;
    setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', text }]);
    setInputValue('');
    setIsTyping(true);

    try {
      const response = await chatRef.current.sendMessage({ message: text });
      setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: 'model', text: response.text }]);
    } catch (err) {
      setMessages(prev => [...prev, { id: 'err', role: 'model', text: "Bhai thoda busy ho gaya lagta hai, fir se bol na?" }]);
    } finally {
      setIsTyping(false);
    }
  };

  const startVoice = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey });
      
      const inCtx = new AudioContext({ sampleRate: 16000 });
      const outCtx = new AudioContext({ sampleRate: 24000 });
      audioCtxRef.current = { input: inCtx, output: outCtx };

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inCtx.createMediaStreamSource(stream);
            const processor = inCtx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const data = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(data.length);
              for (let i = 0; i < data.length; i++) int16[i] = data[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({
                media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' }
              }));
            };
            source.connect(processor);
            processor.connect(inCtx.destination);
            setIsLive(true);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const base64 = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64 && audioCtxRef.current) {
              setIsSpeaking(true);
              const ctx = audioCtxRef.current.output;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(base64), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => {
                activeSources.current.delete(source);
                if (activeSources.current.size === 0) setIsSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              activeSources.current.add(source);
            }
            if (msg.serverContent?.interrupted) {
              activeSources.current.forEach(s => s.stop());
              activeSources.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: () => setIsLive(false),
          onclose: () => setIsLive(false)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          systemInstruction: RAKSHAK_PROMPT
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (e) {
      alert("Mic permission check kar behen!");
    }
  };

  const stopVoice = () => {
    if (liveSessionRef.current) {
      liveSessionRef.current.close();
      liveSessionRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.input.close();
      audioCtxRef.current.output.close();
      audioCtxRef.current = null;
    }
    activeSources.current.forEach(s => s.stop());
    activeSources.current.clear();
    setIsLive(false);
    setIsSpeaking(false);
  };

  return (
    <div className="fixed inset-0 pointer-events-none flex items-end justify-end p-4 md:p-8 z-50">
      {isOpen ? (
        <div className="pointer-events-auto w-full max-w-[420px] h-[85vh] md:h-[680px] flex flex-col glass rounded-[2.5rem] shadow-[0_25px_60px_-15px_rgba(0,0,0,0.3)] border border-white/50 animate-widget overflow-hidden">
          {/* Header */}
          <header className="bg-gradient-to-r from-indigo-700 via-violet-700 to-fuchsia-700 p-6 flex items-center justify-between text-white">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center text-xl font-bold backdrop-blur-md border border-white/30 rotate-3">
                  RB
                </div>
                <div className="absolute -bottom-1 -right-1 w-3.5 h-3.5 bg-green-400 border-2 border-white rounded-full"></div>
              </div>
              <div>
                <h2 className="font-bold text-lg tracking-tight">Rakshak Bhai</h2>
                <p className="text-[10px] font-black uppercase tracking-widest opacity-70">
                  {isLive ? '• Dil Ki Baat Ho Rahi Hai' : '• Hamesha Online'}
                </p>
              </div>
            </div>
            <button 
              onClick={() => { stopVoice(); setIsOpen(false); }}
              className="w-10 h-10 rounded-full bg-black/10 hover:bg-black/20 flex items-center justify-center transition-all"
            >
              <span className="text-xl">✕</span>
            </button>
          </header>

          {/* Body */}
          <main className="flex-1 overflow-hidden relative flex flex-col">
            {isLive ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 bg-indigo-50/30">
                <div className="relative mb-12">
                  {isSpeaking && (
                    <div className="absolute inset-0 bg-indigo-500/20 rounded-full animate-ping scale-150"></div>
                  )}
                  <div className={`w-48 h-48 rounded-full flex flex-col items-center justify-center transition-all duration-700 shadow-2xl z-20 ${isSpeaking ? 'bg-indigo-600 scale-105' : 'bg-white border-4 border-indigo-100'}`}>
                    <div className="text-5xl mb-3">{isSpeaking ? '🗣️' : '👂'}</div>
                    <span className={`text-[11px] font-black uppercase tracking-widest ${isSpeaking ? 'text-white' : 'text-indigo-400'}`}>
                      {isSpeaking ? 'Bhai Bol Raha Hai' : 'Main Sun Raha Hoon'}
                    </span>
                  </div>
                </div>
                <p className="text-indigo-900/60 font-medium italic text-center px-6 mb-8">
                  "Koi tension nahi, sab bol de jo mann mein hai..."
                </p>
                <button 
                  onClick={stopVoice}
                  className="px-10 py-5 bg-red-500 hover:bg-red-600 text-white rounded-full font-bold shadow-xl active:scale-95 transition-all flex items-center gap-3"
                >
                  <span>Phone Rakho</span>
                  <span className="text-2xl">🛑</span>
                </button>
              </div>
            ) : (
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 no-scrollbar bg-slate-50/50">
                {messages.map(m => (
                  <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`
                      max-w-[85%] px-5 py-4 rounded-3xl text-[15px] leading-relaxed shadow-sm
                      ${m.role === 'user' 
                        ? 'bg-indigo-600 text-white rounded-br-none' 
                        : 'bg-white text-slate-800 rounded-bl-none border border-indigo-100/50'}
                    `}>
                      {m.text}
                    </div>
                  </div>
                ))}
                {isTyping && (
                  <div className="flex gap-2 items-center px-5 py-3 bg-indigo-50 w-max rounded-full shadow-sm">
                    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce"></div>
                    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                    <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                    <span className="text-[10px] text-indigo-400 font-black ml-2 uppercase tracking-tighter">Bhai likh raha hai...</span>
                  </div>
                )}
              </div>
            )}
          </main>

          {/* Footer */}
          {!isLive && (
            <footer className="p-5 bg-white border-t border-indigo-50 flex gap-4 items-center shadow-[0_-10px_20px_rgba(0,0,0,0.02)]">
              <button 
                onClick={startVoice}
                className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center hover:bg-indigo-100 transition-all shadow-inner group"
                title="Bhai se baat karo"
              >
                <span className="text-2xl group-hover:scale-110 transition-transform">🎤</span>
              </button>
              <form onSubmit={sendMessage} className="flex-1 flex gap-3">
                <input 
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  placeholder="Kuch kehna hai?..."
                  className="flex-1 bg-slate-100 border-none rounded-2xl px-6 text-[15px] outline-none focus:ring-2 focus:ring-indigo-100 transition-all font-medium"
                />
                <button 
                  type="submit"
                  disabled={!inputValue.trim() || isTyping}
                  className="w-14 h-14 bg-indigo-600 text-white rounded-2xl shadow-lg flex items-center justify-center hover:bg-indigo-700 disabled:bg-slate-300 disabled:shadow-none transition-all active:scale-95"
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
          onClick={() => setIsOpen(true)}
          className="pointer-events-auto group relative p-1"
        >
          <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-20 group-hover:opacity-40 transition-all duration-1000"></div>
          <div className="w-20 h-20 bg-gradient-to-br from-indigo-600 via-violet-700 to-fuchsia-700 rounded-full shadow-[0_20px_50px_rgba(79,70,229,0.4)] flex items-center justify-center text-4xl transform transition-transform group-hover:scale-110 active:scale-90 border-4 border-white relative z-10">
            ❤️
          </div>
          <div className="absolute -top-16 right-0 bg-white px-5 py-3 rounded-2xl shadow-2xl text-[13px] font-black text-indigo-700 whitespace-nowrap border border-indigo-100 animate-bounce pointer-events-none">
            Bhai hai na, fikr mat kar! ✨
          </div>
        </button>
      )}
    </div>
  );
};

export default App;