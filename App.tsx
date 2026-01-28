
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Chat, GenerateContentResponse } from '@google/genai';

const RAKSHAK_PROMPT = `
Tera naam "Rakshak" hai. Tum ek "Big Brother" (Bhai) aur "Best Friend" ka combination ho.
Kaam: Tum un ladkiyon ki help karte ho jo life ke mushkil waqt se guzar rahi hain ya jinhe koi sunne wala chahiye.
Personality: 
- Boht patience rakho.
- Voice conversation mein "Puck" voice use karo.
- Hinglish use karo (Jaise: "Oye pagal", "Tension mat le", "Bhai khada hai na yahan").
- Kabhi judge mat karo. Hamesha support karo.
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

interface Message {
  role: 'user' | 'model';
  text: string;
}

const App: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<'home' | 'chat' | 'call'>('home');
  const [isCalling, setIsCalling] = useState(false);
  const [isBhaiSpeaking, setIsBhaiSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', text: 'Oye! Kya haal hain? Bhai yahan hai, bol kya karna hai?' }
  ]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  const rakshakAudioCtx = useRef<{ input: AudioContext, output: AudioContext } | null>(null);
  const liveSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const activeSources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef(0);
  const chatInstanceRef = useRef<Chat | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isTyping, view]);

  // Fix: Added toggleWidget function to manage the open/close state of the UI widget
  const toggleWidget = () => {
    if (isOpen) {
      stopCall();
    }
    setIsOpen(!isOpen);
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim() || isTyping) return;
    const userMsg = inputText.trim();
    setInputText('');
    setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsTyping(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      if (!chatInstanceRef.current) {
        chatInstanceRef.current = ai.chats.create({
          model: 'gemini-3-flash-preview',
          config: { systemInstruction: RAKSHAK_PROMPT }
        });
      }
      const result = await chatInstanceRef.current.sendMessageStream({ message: userMsg });
      let fullResponse = '';
      setMessages(prev => [...prev, { role: 'model', text: '' }]);
      for await (const chunk of result) {
        const part = chunk as GenerateContentResponse;
        if (part.text) {
          fullResponse += part.text;
          setMessages(prev => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'model', text: fullResponse };
            return updated;
          });
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'model', text: 'Network issue, phir se bol?' }]);
    } finally { setIsTyping(false); }
  };

  const startCall = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return;
    setView('call');
    setIsCalling(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const inCtx = new AudioContext({ sampleRate: 16000 });
      const outCtx = new AudioContext({ sampleRate: 24000 });
      rakshakAudioCtx.current = { input: inCtx, output: outCtx };
      const ai = new GoogleGenAI({ apiKey });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inCtx.createMediaStreamSource(stream);
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const input = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(input.length);
              for (let i = 0; i < input.length; i++) int16[i] = input[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ 
                media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } 
              }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const base64 = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64 && rakshakAudioCtx.current) {
              setIsBhaiSpeaking(true);
              const ctx = rakshakAudioCtx.current.output;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(base64), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.onended = () => {
                activeSources.current.delete(source);
                if (activeSources.current.size === 0) setIsBhaiSpeaking(false);
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              activeSources.current.add(source);
            }
          },
          onclose: () => stopCall(),
          onerror: () => stopCall()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          systemInstruction: RAKSHAK_PROMPT
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (e) { stopCall(); }
  };

  const stopCall = () => {
    if (liveSessionRef.current) liveSessionRef.current.close();
    if (rakshakAudioCtx.current) {
      rakshakAudioCtx.current.input.close();
      rakshakAudioCtx.current.output.close();
    }
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop());
    setIsCalling(false);
    setIsBhaiSpeaking(false);
    setView('home');
  };

  return (
    <div className="flex flex-col items-end justify-end p-5 md:p-8 h-screen w-screen">
      
      {/* --- BOT WINDOW --- */}
      {isOpen && (
        <div className="pointer-events-auto w-[92vw] max-w-[380px] h-[70vh] max-h-[600px] bg-white rounded-[2rem] shadow-[0_25px_70px_-15px_rgba(0,0,0,0.5)] border border-slate-200 flex flex-col overflow-hidden mb-6 animate-widget relative">
          
          <header className="p-4 flex items-center justify-between bg-slate-50 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <button onClick={() => setView('home')} className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-100 transition-all hover:scale-105 active:scale-95">
                {view === 'home' ? '🛡️' : '←'}
              </button>
              <div>
                <h2 className="text-slate-800 font-black text-xs uppercase tracking-widest leading-none m-0">Rakshak Bhai</h2>
                <span className="text-[10px] text-green-500 font-bold uppercase tracking-tighter">Online Hai</span>
              </div>
            </div>
            <button onClick={() => { stopCall(); setIsOpen(false); }} className="text-slate-400 hover:text-slate-600 text-2xl">✕</button>
          </header>

          <div className="flex-1 overflow-hidden relative bg-white">
            {view === 'home' && (
              <div className="h-full flex flex-col items-center justify-center p-8 space-y-10 animate-fade">
                <div className="text-center">
                  <h3 className="text-3xl font-black text-slate-800 italic">Oye Pagal!</h3>
                  <p className="text-slate-500 text-sm font-medium mt-2">Bhai yahan hai, bol kya baat hai?</p>
                </div>
                <div className="flex flex-col w-full gap-4">
                  <button onClick={startCall} className="py-5 bg-indigo-600 text-white rounded-2xl font-black text-lg shadow-xl shadow-indigo-100 active:scale-95 transition-all">📞 Bhai Se Baat Kar</button>
                  <button onClick={() => setView('chat')} className="py-5 bg-slate-50 border border-slate-200 text-slate-700 rounded-2xl font-black text-lg active:scale-95 transition-all">💬 Message Kar De</button>
                </div>
              </div>
            )}

            {view === 'chat' && (
              <div className="h-full flex flex-col animate-fade">
                <main ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/50">
                  {messages.map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] p-4 rounded-[1.5rem] text-[13px] font-semibold leading-relaxed shadow-sm ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-br-none' : 'bg-white text-slate-700 border border-slate-100 rounded-bl-none'}`}>
                        {m.text || <span className="animate-pulse">Typing...</span>}
                      </div>
                    </div>
                  ))}
                </main>
                <footer className="p-4 bg-white border-t">
                  <form onSubmit={handleSendMessage} className="relative">
                    <input type="text" value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="Bhai ko likh..." className="w-full bg-slate-50 border border-slate-200 rounded-full py-4 px-6 pr-14 text-sm focus:outline-none focus:border-indigo-500 transition-all font-medium" />
                    <button type="submit" disabled={!inputText.trim()} className="absolute right-2 top-1.5 w-10 h-10 bg-indigo-600 text-white rounded-full flex items-center justify-center shadow-lg active:scale-90 disabled:opacity-30">➔</button>
                  </form>
                </footer>
              </div>
            )}

            {view === 'call' && (
              <div className="h-full flex flex-col items-center justify-center p-8 bg-indigo-600 text-white animate-fade">
                <div className={`w-44 h-44 rounded-full border-4 border-white/20 flex items-center justify-center relative transition-all duration-700 ${isBhaiSpeaking ? 'scale-110 shadow-[0_0_80px_rgba(255,255,255,0.3)]' : ''}`}>
                  <span className="text-8xl">{isBhaiSpeaking ? '🗣️' : '🛡️'}</span>
                </div>
                <p className="mt-10 font-black text-xl tracking-widest uppercase">{isBhaiSpeaking ? 'Bhai Bol Raha Hai...' : 'Listening...'}</p>
                <button onClick={stopCall} className="mt-14 w-20 h-20 bg-white text-red-600 rounded-full flex items-center justify-center shadow-2xl active:scale-90">📞</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- FLOATING BUBBLE --- */}
      <button onClick={toggleWidget} className="pointer-events-auto w-[70px] h-[70px] bg-indigo-600 rounded-full shadow-[0_10px_40px_-5px_rgba(79,70,229,0.5)] flex items-center justify-center text-3xl border-2 border-white/20 active:scale-90 transition-all hover:scale-110 relative z-[100000]">
        <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-20"></div>
        {isOpen ? <span className="text-white text-2xl font-light">✕</span> : '🛡️'}
        {!isOpen && (
          <div className="absolute -top-16 right-0 bg-white border border-slate-100 text-indigo-700 px-5 py-2.5 rounded-2xl shadow-xl text-[11px] font-black animate-bounce whitespace-nowrap after:content-[''] after:absolute after:top-full after:right-6 after:border-8 after:border-transparent after:border-t-white">
            Bhai Yahan Hai! ✨
          </div>
        )}
      </button>

      <style>{`
        @keyframes widgetPop {
          from { transform: scale(0.5) translateY(50px) translateX(20px); opacity: 0; filter: blur(10px); }
          to { transform: scale(1) translateY(0) translateX(0); opacity: 1; filter: blur(0); }
        }
        .animate-widget { animation: widgetPop 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; transform-origin: bottom right; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .animate-fade { animation: fadeIn 0.3s ease-out forwards; }
      `}</style>
    </div>
  );
};

export default App;
