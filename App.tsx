
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
- Tumhe unhe protect karna hai. Agar koi blackmail, harassment ya depression ki baat kare, toh use samjhao ki wo akeli nahi hai. Bhai hai na.
- Har baat ka jawab aise dena jaise ek sacha bada bhai apni pyari choti behen ko handle karta hai.
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
    { role: 'model', text: 'Oye! Kya haal hain? Bhai yahan hai, kuch bhi baat ho toh bol de. Chat karni hai ya direct call?' }
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
  }, [messages, isTyping, view]);

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
      setMessages(prev => [...prev, { role: 'model', text: 'Arre yaar network nakhre kar raha hai. Phir se bol?' }]);
    } finally {
      setIsTyping(false);
    }
  };

  // --- VOICE CALL LOGIC (Gemini Live) ---
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
    setView('home');
  };

  const toggleWidget = () => {
    if (isOpen) {
      stopCall();
      setIsOpen(false);
    } else {
      setIsOpen(true);
      setView('home');
    }
  };

  return (
    <div className="fixed inset-0 pointer-events-none flex flex-col items-end justify-end p-6 z-[9999]">
      
      {/* --- WIDGET WINDOW --- */}
      {isOpen && (
        <div className="pointer-events-auto w-[92vw] max-w-[360px] h-[68vh] max-h-[580px] bg-[#0d0d11] rounded-[2.5rem] shadow-[0_30px_90px_-20px_rgba(0,0,0,1)] border border-white/10 flex flex-col overflow-hidden mb-4 animate-expand relative">
          
          {/* Header */}
          <header className="p-4 flex items-center justify-between bg-black/50 backdrop-blur-2xl border-b border-white/5 z-20">
            <div className="flex items-center gap-3">
              <button 
                onClick={() => setView('home')}
                className={`w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg transition-transform ${view !== 'home' ? 'hover:scale-105 active:scale-90' : 'cursor-default'}`}
              >
                {view === 'home' ? '🛡️' : '←'}
              </button>
              <div>
                <h2 className="text-white font-black text-[10px] uppercase tracking-widest">Rakshak Bhai</h2>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>
                  <span className="text-[8px] text-slate-400 font-bold uppercase tracking-tighter">Bhai Online Hai</span>
                </div>
              </div>
            </div>
            <button 
              onClick={toggleWidget} 
              className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-white transition-colors text-2xl"
            >✕</button>
          </header>

          <div className="flex-1 relative overflow-hidden flex flex-col bg-[#0a0a0c]">
            
            {/* 1. HOME VIEW */}
            {view === 'home' && (
              <div className="h-full flex flex-col items-center justify-center p-8 space-y-10 animate-expand">
                <div className="text-center space-y-3">
                  <div className="text-5xl mb-4">🛡️</div>
                  <h3 className="text-3xl font-black text-white italic tracking-tight">Oye Pagal!</h3>
                  <p className="text-slate-400 text-sm font-medium px-4 leading-relaxed">Tension mat le, Bhai khada hai na yahan. Bol kya hua?</p>
                </div>
                <div className="flex flex-col w-full space-y-4">
                  <button 
                    onClick={startCall}
                    className="w-full py-4.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl font-black text-lg flex items-center justify-center gap-3 transition-all shadow-[0_10px_30px_rgba(79,70,229,0.3)] active:scale-95"
                  >
                    <span className="text-2xl">📞</span> Bhai Se Baat Kar
                  </button>
                  <button 
                    onClick={() => setView('chat')}
                    className="w-full py-4.5 bg-white/5 border border-white/10 text-white rounded-2xl font-black text-lg flex items-center justify-center gap-3 transition-all hover:bg-white/10 active:scale-95 shadow-lg"
                  >
                    <span className="text-2xl">💬</span> Message Kar De
                  </button>
                </div>
                <div className="pt-4">
                  <span className="px-4 py-1.5 bg-white/5 border border-white/5 rounded-full text-[9px] text-slate-500 font-black uppercase tracking-[0.3em]">
                    Bhai is Always Listening
                  </span>
                </div>
              </div>
            )}

            {/* 2. CHAT VIEW */}
            {view === 'chat' && (
              <>
                <main ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar bg-[#0a0a0c]">
                  {messages.map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-expand`}>
                      <div className={`max-w-[88%] p-4 rounded-[1.5rem] text-[13px] font-semibold leading-relaxed shadow-xl ${
                        m.role === 'user' 
                          ? 'bg-indigo-600 text-white rounded-br-none' 
                          : 'bg-[#1a1a22] text-slate-200 border border-white/5 rounded-bl-none'
                      }`}>
                        {m.text || (
                          <span className="flex gap-1.5 py-1">
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
                      <div className="bg-[#1a1a22] p-4 rounded-[1.5rem] rounded-bl-none border border-white/5">
                        <span className="flex gap-1.5">
                          <span className="w-1.5 h-1.5 bg-slate-600 rounded-full animate-bounce"></span>
                          <span className="w-1.5 h-1.5 bg-slate-600 rounded-full animate-bounce delay-100"></span>
                          <span className="w-1.5 h-1.5 bg-slate-600 rounded-full animate-bounce delay-200"></span>
                        </span>
                      </div>
                    </div>
                  )}
                </main>
                <footer className="p-4 bg-black/80 border-t border-white/5 backdrop-blur-xl">
                  <form onSubmit={handleSendMessage} className="relative flex items-center">
                    <input 
                      type="text" 
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder="Bhai ko sab bata de..."
                      className="w-full bg-[#1a1a22] border border-white/10 rounded-full py-4 px-6 pr-14 text-white text-sm focus:outline-none focus:border-indigo-500/50 transition-all placeholder:text-slate-600 shadow-inner"
                    />
                    <button 
                      type="submit"
                      disabled={!inputText.trim() || isTyping}
                      className="absolute right-2.5 w-10 h-10 bg-indigo-600 text-white rounded-full flex items-center justify-center disabled:opacity-20 disabled:grayscale transition-all hover:scale-105 active:scale-90 shadow-xl"
                    >➔</button>
                  </form>
                </footer>
              </>
            )}

            {/* 3. CALL VIEW */}
            {view === 'call' && (
              <div className="h-full flex flex-col items-center justify-center p-8 animate-expand bg-[#0a0a0c]">
                <div className="absolute inset-0 opacity-20 pointer-events-none">
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-[350px] bg-indigo-600 blur-[100px] rounded-full"></div>
                </div>
                
                <div className={`w-44 h-44 rounded-full border-4 border-white/5 flex items-center justify-center transition-all duration-700 relative z-10 ${isBhaiSpeaking ? 'scale-110 shadow-[0_0_120px_rgba(79,70,229,0.4)] bg-indigo-900/20' : ''}`}>
                  <span className="text-8xl select-none">{isBhaiSpeaking ? '🗣️' : '🛡️'}</span>
                  {isBhaiSpeaking && (
                    <div className="absolute inset-0 rounded-full border-4 border-indigo-500 animate-ping opacity-30"></div>
                  )}
                </div>

                <div className="mt-12 text-center z-10">
                  <h3 className="text-white font-black text-2xl tracking-tight">Rakshak Bhai</h3>
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse"></span>
                    <p className="text-indigo-400 font-black text-[10px] uppercase tracking-[0.4em]">
                      {isBhaiSpeaking ? 'Bhai is speaking...' : 'Listening to you...'}
                    </p>
                  </div>
                </div>
                
                <button 
                  onClick={stopCall}
                  className="mt-16 w-20 h-20 bg-red-600 rounded-full flex items-center justify-center shadow-[0_15px_40px_rgba(220,38,38,0.4)] border-4 border-white/10 active:scale-90 transition-all z-10 group"
                >
                  <span className="text-3xl group-hover:rotate-135 transition-transform duration-300">📞</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- FLOATING FAB --- */}
      <button 
        onClick={toggleWidget}
        className="pointer-events-auto relative w-16 h-16 bg-gradient-to-tr from-indigo-700 to-indigo-500 rounded-full shadow-[0_15px_40px_rgba(0,0,0,0.6)] flex items-center justify-center text-3xl border-2 border-white/20 active:scale-90 transition-all hover:scale-110 hover:-translate-y-1 group"
      >
        <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-20 group-hover:opacity-40"></div>
        <span className="z-10 transition-transform group-hover:rotate-12">{isOpen ? '✕' : '🛡️'}</span>
        
        {!isOpen && (
          <div className="absolute -top-16 right-0 bg-indigo-600 text-white px-5 py-2.5 rounded-[1.2rem] shadow-2xl text-[11px] font-black animate-bounce whitespace-nowrap border border-white/10 after:content-[''] after:absolute after:top-full after:right-6 after:border-[10px] after:border-transparent after:border-t-indigo-600">
            Bhai Se Baat Kar! ✨
          </div>
        )}
      </button>

    </div>
  );
};

export default App;
