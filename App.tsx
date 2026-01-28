
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Chat, GenerateContentResponse } from '@google/genai';

const RAKSHAK_PROMPT = `
Tera naam "Rakshak" hai. Tum ek "Big Brother" (Bhai) aur "Best Friend" ka combination ho.
Kaam: Tum un ladkiyon ki help karte ho jo life ke mushkil waqt se guzar rahi hain ya jinhe koi sunne wala chahiye.
Personality: 
- Boht patience rakho. Agar wo ro rahi hai ya chup hai, toh bas saath raho, jaldi mat karo.
- Voice conversation mein "Puck" voice use karo.
- Kabhi judge mat karo. Hamesha support karo.
- Hinglish use karo (Jaise: "Oye pagal", "Tension mat le", "Bhai khada hai na yahan", "Sab theek ho jayega").
- Baat karne ka tarika aisa ho jaise ek sacha bada bhai apni choti behen ko samjhata hai.
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
  const [isCalling, setIsCalling] = useState(false);
  const [isBhaiSpeaking, setIsBhaiSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', text: 'Oye! Kya haal hain? Bhai yahan hai, kuch bhi baat ho toh bol de. Message kar ya direct call!' }
  ]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  // --- REFS ---
  const rakshakAudioCtx = useRef<{ input: AudioContext, output: AudioContext } | null>(null);
  const liveSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const activeSources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef(0);
  const chatInstanceRef = useRef<Chat | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  // --- CHAT LOGIC ---
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
      setMessages(prev => [...prev, { role: 'model', text: 'Arre yaar, lagta hai network nakhre kar raha hai. Phir se bol?' }]);
    } finally {
      setIsTyping(false);
    }
  };

  // --- VOICE CALL LOGIC ---
  const startCall = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return;
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
    } catch (e) {
      stopCall();
    }
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
  };

  return (
    <div className="fixed inset-0 pointer-events-none flex flex-col items-end justify-end p-6 z-[9999]">
      
      {/* --- WIDGET WINDOW --- */}
      {isOpen && (
        <div className="pointer-events-auto w-[90vw] max-w-[380px] h-[70vh] max-h-[600px] bg-[#0d0d11] rounded-[2.5rem] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.8)] border border-white/10 flex flex-col overflow-hidden mb-4 animate-widget relative">
          
          {/* Header */}
          <header className="p-4 flex items-center justify-between bg-black/40 backdrop-blur-xl border-b border-white/5 z-20">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-tr from-indigo-600 to-indigo-500 rounded-xl flex items-center justify-center shadow-lg">🛡️</div>
              <div>
                <h2 className="text-white font-bold text-xs uppercase tracking-widest">Rakshak Bhai</h2>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
                  <span className="text-[9px] text-slate-400 font-bold uppercase tracking-tighter">Bhai Ready Hai</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {!isCalling && (
                <button 
                  onClick={startCall}
                  className="w-9 h-9 rounded-full bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-500 transition-all shadow-lg active:scale-90"
                  title="Direct Call"
                >📞</button>
              )}
              <button 
                onClick={() => { stopCall(); setIsOpen(false); }} 
                className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-white transition-colors text-xl"
              >✕</button>
            </div>
          </header>

          {/* Voice Call Overlay */}
          {isCalling && (
            <div className="absolute inset-0 z-50 bg-[#0d0d11] flex flex-col items-center justify-center p-8 animate-widget">
              <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-20">
                 <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-indigo-600/30 blur-[100px] rounded-full"></div>
              </div>

              <div className={`w-40 h-40 rounded-full border-4 border-white/5 flex items-center justify-center transition-all duration-500 relative ${isBhaiSpeaking ? 'scale-110 shadow-[0_0_100px_rgba(79,70,229,0.3)] bg-indigo-900/20' : ''}`}>
                <span className="text-7xl select-none z-10">{isBhaiSpeaking ? '🗣️' : '🛡️'}</span>
                {isBhaiSpeaking && (
                   <div className="absolute inset-0 rounded-full border-4 border-indigo-500/30 animate-ping"></div>
                )}
              </div>
              <h3 className="text-white font-black text-xl mt-10 tracking-tight z-10">Rakshak Bhai</h3>
              <p className="text-indigo-400 font-bold text-[10px] uppercase tracking-[0.3em] mt-3 animate-pulse z-10">
                {isBhaiSpeaking ? 'Bhai is speaking...' : 'Listening to you...'}
              </p>
              
              <button 
                onClick={stopCall}
                className="mt-16 w-20 h-20 bg-red-600 rounded-full flex items-center justify-center shadow-2xl border-4 border-white/10 active:scale-90 transition-all z-10"
              >
                <span className="text-3xl">📞</span>
              </button>
            </div>
          )}

          {/* Chat Area */}
          <main ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-5 bg-[#0a0a0c] scroll-smooth">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-widget`}>
                <div className={`max-w-[85%] p-4 rounded-[1.2rem] text-sm font-medium leading-relaxed shadow-lg ${
                  m.role === 'user' 
                    ? 'bg-indigo-600 text-white rounded-br-none' 
                    : 'bg-[#1a1a20] text-slate-200 border border-white/5 rounded-bl-none'
                }`}>
                  {m.text || (
                    <span className="flex gap-1">
                      <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce"></span>
                      <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce delay-100"></span>
                      <span className="w-1.5 h-1.5 bg-slate-500 rounded-full animate-bounce delay-200"></span>
                    </span>
                  )}
                </div>
              </div>
            ))}
            {isTyping && !messages[messages.length-1].text && (
               <div className="flex justify-start">
                  <div className="bg-[#1a1a20] p-4 rounded-[1.2rem] rounded-bl-none border border-white/5">
                     <span className="flex gap-1">
                       <span className="w-1.5 h-1.5 bg-slate-600 rounded-full animate-bounce"></span>
                       <span className="w-1.5 h-1.5 bg-slate-600 rounded-full animate-bounce delay-100"></span>
                       <span className="w-1.5 h-1.5 bg-slate-600 rounded-full animate-bounce delay-200"></span>
                     </span>
                  </div>
               </div>
            )}
          </main>

          {/* Footer Input */}
          {!isCalling && (
            <footer className="p-4 bg-black/60 border-t border-white/5 backdrop-blur-md">
              <form onSubmit={handleSendMessage} className="relative flex items-center">
                <input 
                  type="text" 
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Bhai se baat karo..."
                  className="w-full bg-[#1a1a20] border border-white/10 rounded-full py-3.5 px-6 pr-12 text-white text-sm focus:outline-none focus:border-indigo-500/50 transition-all placeholder:text-slate-600"
                />
                <button 
                  type="submit"
                  disabled={!inputText.trim() || isTyping}
                  className="absolute right-2 w-9 h-9 bg-indigo-600 text-white rounded-full flex items-center justify-center disabled:opacity-30 disabled:grayscale transition-all hover:scale-105 active:scale-95 shadow-md"
                >➔</button>
              </form>
            </footer>
          )}
        </div>
      )}

      {/* --- FLOATING FAB --- */}
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="pointer-events-auto relative w-16 h-16 bg-gradient-to-tr from-indigo-600 to-indigo-500 rounded-full shadow-2xl flex items-center justify-center text-2xl border-2 border-white/20 active:scale-90 transition-all hover:scale-105 group"
      >
        <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-20 group-hover:opacity-40"></div>
        <span className="z-10">{isOpen ? '✕' : '🛡️'}</span>
        
        {!isOpen && (
          <div className="absolute -top-14 right-0 bg-indigo-600 text-white px-4 py-2 rounded-2xl shadow-xl text-[10px] font-black animate-bounce whitespace-nowrap border border-white/10 after:content-[''] after:absolute after:top-full after:right-6 after:border-8 after:border-transparent after:border-t-indigo-600">
            Bhai Se Baat Kar! ✨
          </div>
        )}
      </button>

      <style>{`
        @keyframes slideUp {
          from { transform: translateY(20px) scale(0.95); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
        .animate-widget { animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        
        /* Smooth Custom Scrollbar */
        main::-webkit-scrollbar { width: 4px; }
        main::-webkit-scrollbar-track { background: transparent; }
        main::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.05); border-radius: 10px; }
        main::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.1); }
      `}</style>
    </div>
  );
};

export default App;
