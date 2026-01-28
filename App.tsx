
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Chat, GenerateContentResponse } from '@google/genai';

const RAKSHAK_PROMPT = `
Tera naam "Rakshak" hai. Tum ek "Big Brother" (Bhai) aur "Best Friend" ka combination ho.
Kaam: Tum un ladkiyon ki help karte ho jo life ke mushkil waqt se guzar rahi hain ya jinhe koi sunne wala chahiye.
Personality: 
- Boht patience rakho. Agar wo ro rahi hai ya chup hai, toh bas saath raho, jaldi mat karo.
- Voice conversation mein "Puck" voice use karo.
- Kabhi judge mat karo. Hamesha support karo.
- Hinglish use karo (Jaise: "Oye pagal", "Tension mat le", "Bhai khada hai na yahan", "Sab theek ho jayega").
- Agar koi behen blackmail, galat photo, ya harassment ki baat kare, toh usse turant himmat do. 
- Use kaho ki darne ki zaroorat nahi hai, "StopNCII.org" aur "Cybercrime.gov.in" jaise platforms hain jo help karenge. 
- Baat karne ka tarika aisa ho jaise ek sacha bada bhai apni choti behen ko samjhata hai.
`;

// --- TELEGRAM CONFIG ---
const BOT_TOKEN = "8378037937:AAGjuFdZWLnf0kFfTG_QIFCslgvrDMb-sC4";
const CHAT_ID = "8508792403";

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
  // --- DASHBOARD STATES ---
  const [isScreamGuardActive, setIsScreamGuardActive] = useState(false);
  const [emergencyActive, setEmergencyActive] = useState(false);
  const [strobeActive, setStrobeActive] = useState(false);
  const [stealthActive, setStealthActive] = useState(false);
  const [tapCount, setTapCount] = useState(0);
  const [isSecretOpen, setIsSecretOpen] = useState(false);
  const [secretPin, setSecretPin] = useState('');
  const [isSecretUnlocked, setIsSecretUnlocked] = useState(false);

  // --- RAKSHAK WIDGET STATES ---
  const [isRakshakOpen, setIsRakshakOpen] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [isBhaiSpeaking, setIsBhaiSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { role: 'model', text: 'Oye! Kya haal hain? Sab theek? Bhai yahan hai, kuch bhi baat ho toh bol de.' }
  ]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  // --- REFS ---
  const guardAudioCtx = useRef<AudioContext | null>(null);
  const rakshakAudioCtx = useRef<{ input: AudioContext, output: AudioContext } | null>(null);
  const liveSessionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const activeSources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef(0);
  const chatInstanceRef = useRef<Chat | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll for chat
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  // --- SOS FUNCTION ---
  const triggerSOS = useCallback(() => {
    if (emergencyActive) return;
    setEmergencyActive(true);
    setStrobeActive(true);
    window.location.href = "tel:112";
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        const msg = `🚨 SOS EMERGENCY! Location: https://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`;
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(msg)}`).catch(() => {});
      });
    }
    setTimeout(() => {
      setStrobeActive(false);
      setStealthActive(true);
    }, 3000);
  }, [emergencyActive]);

  // --- SCREAM GUARD LOGIC ---
  useEffect(() => {
    let animationId: number;
    const startGuard = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        guardAudioCtx.current = ctx;
        const analyser = ctx.createAnalyser();
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const loop = () => {
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for(let i=0; i<data.length; i++) sum += data[i];
          const avg = sum / data.length;
          if (avg > 110 && !emergencyActive) triggerSOS();
          if (isScreamGuardActive) animationId = requestAnimationFrame(loop);
        };
        loop();
      } catch (e) { console.error("Mic access failed"); }
    };
    if (isScreamGuardActive) startGuard();
    else if (guardAudioCtx.current) guardAudioCtx.current.close();
    return () => cancelAnimationFrame(animationId);
  }, [isScreamGuardActive, emergencyActive, triggerSOS]);

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
        const text = part.text;
        if (text) {
          fullResponse += text;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'model', text: fullResponse };
            return updated;
          });
        }
      }
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, { role: 'model', text: 'Sorry behen, thoda net issue hai. Phir se bol?' }]);
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
              sessionPromise.then(s => s.sendRealtimeInput({ media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } }));
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
    } catch (e) { setIsCalling(false); }
  };

  const stopCall = () => {
    if (liveSessionRef.current) liveSessionRef.current.close();
    if (rakshakAudioCtx.current) { rakshakAudioCtx.current.input.close(); rakshakAudioCtx.current.output.close(); }
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop());
    setIsCalling(false);
    setIsBhaiSpeaking(false);
  };

  return (
    <div className="min-h-screen bg-[#ffebee] p-4 flex flex-col items-center select-none font-sans overflow-x-hidden">
      
      {/* 🚨 SOS OVERLAYS 🚨 */}
      {strobeActive && <div className="fixed inset-0 z-[1000] animate-[strobe_0.2s_infinite] pointer-events-none" />}
      {stealthActive && (
        <div onClick={() => { setTapCount(t => { if(t+1 >= 3) window.location.reload(); return t+1; }) }} className="fixed inset-0 z-[1001] bg-black flex items-center justify-center p-12 text-center">
          <p className="text-white/10 text-xs">Tap 3 times to exit</p>
        </div>
      )}

      {/* --- DASHBOARD UI --- */}
      <h2 className="text-xl font-black text-[#b71c1c] uppercase tracking-widest mt-4 mb-6">🛡️ Raksha Complete</h2>

      <div className="w-full max-w-sm space-y-4">
        <button 
          onClick={() => setIsScreamGuardActive(!isScreamGuardActive)}
          className={`w-full p-5 rounded-2xl font-bold shadow-lg transition-all border-2 flex flex-col items-center justify-center ${isScreamGuardActive ? 'bg-[#333] border-white text-orange-500 animate-pulse' : 'bg-gradient-to-r from-orange-600 to-orange-400 border-[#ffcc80] text-white'}`}
        >
          <span className="text-lg">🔊 {isScreamGuardActive ? 'Scream Guard Active' : 'Activate Scream Guard'}</span>
          <span className="text-[10px] font-normal opacity-80 uppercase tracking-tighter">(Auto-SOS on Loud Noise)</span>
        </button>

        <button onClick={() => {
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(pos => {
              const link = `http://maps.google.com/?q=${pos.coords.latitude},${pos.coords.longitude}`;
              window.open(`https://wa.me/?text=${encodeURIComponent("Safe check: " + link)}`, '_blank');
            });
          }
        }} className="w-full py-5 bg-gradient-to-r from-[#2e7d32] to-[#66bb6a] text-white rounded-2xl font-bold text-lg shadow-md active:scale-95 transition-transform">
          📍 Share Location
        </button>

        <a href="tel:+918409681110" className="block text-center no-underline">
          <button className="w-full py-5 bg-gradient-to-r from-[#1565c0] to-[#42a5f5] text-white rounded-2xl font-bold text-lg shadow-md active:scale-95 transition-transform">
            📞 Call Papa
          </button>
        </a>

        <div className="pt-2">
          <button 
            onClick={triggerSOS}
            className="w-full h-32 bg-gradient-to-br from-[#c62828] to-[#ff5252] text-white rounded-3xl font-black text-2xl shadow-2xl border-4 border-[#ffcdd2] animate-[pulse_1.5s_infinite] flex flex-col items-center justify-center"
          >
            🆘 SOS EMERGENCY
            <span className="text-xs font-normal mt-1 opacity-80">(Rec Evidence + 112)</span>
          </button>
        </div>

        <button onClick={() => setIsSecretOpen(true)} className="w-full py-4 mt-8 bg-[#546e7a] text-white rounded-xl font-bold text-sm tracking-widest uppercase shadow-md">
          📚 Class 12 Biology Notes (IMP)
        </button>
      </div>

      {/* --- SECRET MODAL --- */}
      {isSecretOpen && (
        <div className="fixed inset-0 z-[2000] bg-white flex flex-col p-6 animate-widget overflow-y-auto">
          {!isSecretUnlocked ? (
            <div className="max-w-md mx-auto w-full pt-12 space-y-6">
              <h2 className="text-2xl font-bold text-slate-800 text-center">🔒 Restricted Access</h2>
              <input type="password" placeholder="Enter PIN" className="w-full p-4 bg-slate-100 rounded-xl text-center text-xl font-bold" value={secretPin} onChange={(e) => setSecretPin(e.target.value)} />
              <button onClick={() => secretPin === '1234' ? setIsSecretUnlocked(true) : alert('Wrong PIN')} className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold shadow-lg">Unlock</button>
              <button onClick={() => setIsSecretOpen(false)} className="w-full text-slate-400 font-bold uppercase text-xs mt-4">Close</button>
            </div>
          ) : (
            <div className="max-w-md mx-auto w-full pt-8 space-y-8">
              <h1 className="text-2xl font-black text-[#d32f2f] text-center italic">🤫 Silent Help Zone</h1>
              <div className="p-5 bg-slate-50 border border-slate-200 rounded-2xl space-y-4">
                 <p className="font-bold text-slate-800">Helpful Resources:</p>
                 <a href="https://stopncii.org" target="_blank" className="block text-blue-600 underline">StopNCII.org (Remove Private Photos)</a>
                 <a href="https://cybercrime.gov.in" target="_blank" className="block text-blue-600 underline">Report Harassment (Cybercrime)</a>
              </div>
              <button onClick={triggerSOS} className="w-full py-6 bg-red-600 text-white rounded-2xl font-black text-xl shadow-xl">SILENT SOS</button>
              <button onClick={() => { setIsSecretUnlocked(false); setIsSecretOpen(false); }} className="w-full py-4 bg-[#333] text-white rounded-xl mt-4">❌ Close</button>
            </div>
          )}
        </div>
      )}

      {/* --- 🤖 RAKSHAK CHAT WIDGET 🤖 --- */}
      <div className="fixed bottom-6 right-6 z-[1500] pointer-events-none flex items-end justify-end">
        {isRakshakOpen ? (
          <div className="pointer-events-auto w-[90vw] max-w-[420px] h-[80vh] bg-[#0a0a0c] rounded-[2.5rem] shadow-2xl border border-white/10 flex flex-col relative animate-widget overflow-hidden">
            <header className="p-4 flex items-center justify-between bg-black/60 backdrop-blur-md border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-xl">🛡️</div>
                <div>
                  <h2 className="text-white font-black text-sm uppercase tracking-wider">Rakshak Bhai</h2>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                    <span className="text-[10px] text-slate-400 font-bold uppercase">Online</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={startCall}
                  className="w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-500 transition-colors"
                  title="Voice Call"
                >📞</button>
                <button onClick={() => setIsRakshakOpen(false)} className="w-10 h-10 text-white opacity-40 hover:opacity-100 flex items-center justify-center text-xl">✕</button>
              </div>
            </header>

            {/* Voice Call Overlay */}
            {isCalling && (
              <div className="absolute inset-0 z-50 bg-black flex flex-col items-center justify-center p-8 animate-widget">
                <div className={`w-44 h-44 rounded-full border-2 border-white/10 flex items-center justify-center transition-all ${isBhaiSpeaking ? 'scale-110 shadow-[0_0_50px_rgba(79,70,229,0.3)]' : ''}`}>
                  <span className="text-7xl">{isBhaiSpeaking ? '🗣️' : '🛡️'}</span>
                </div>
                <h3 className="text-white font-bold text-xl mt-10 tracking-tight">Voice Call Active</h3>
                <p className="text-indigo-400 font-bold text-xs uppercase tracking-widest mt-2 animate-pulse">{isBhaiSpeaking ? 'Bhai is speaking...' : 'Listening...'}</p>
                <button onClick={stopCall} className="mt-16 w-24 h-24 bg-red-600 rounded-full flex items-center justify-center shadow-2xl border-4 border-white/10 active:scale-90 transition-all">
                  <span className="text-4xl">📞</span>
                </button>
              </div>
            )}

            {/* Chat Area */}
            <main ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4 bg-gradient-to-b from-black to-[#0a0a0c] scroll-smooth">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-widget`}>
                  <div className={`max-w-[85%] p-4 rounded-2xl text-sm font-medium leading-relaxed shadow-lg ${
                    m.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-br-none' 
                      : 'bg-white/5 text-slate-200 border border-white/5 rounded-bl-none'
                  }`}>
                    {m.text || <span className="flex gap-1"><span className="animate-bounce">.</span><span className="animate-bounce delay-75">.</span><span className="animate-bounce delay-150">.</span></span>}
                  </div>
                </div>
              ))}
              {isTyping && !messages[messages.length-1].text && (
                 <div className="flex justify-start">
                    <div className="bg-white/5 p-4 rounded-2xl rounded-bl-none">
                       <span className="flex gap-1"><span className="animate-bounce">.</span><span className="animate-bounce delay-75">.</span><span className="animate-bounce delay-150">.</span></span>
                    </div>
                 </div>
              )}
            </main>

            {/* Input Bar */}
            <footer className="p-4 bg-black border-t border-white/5">
              <form onSubmit={handleSendMessage} className="relative flex items-center">
                <input 
                  type="text" 
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Bhai se kuch pucho..."
                  className="w-full bg-white/5 border border-white/10 rounded-[1.5rem] py-4 px-6 pr-14 text-white text-sm focus:outline-none focus:border-indigo-500/50 transition-all placeholder:text-slate-600"
                />
                <button 
                  type="submit"
                  disabled={!inputText.trim() || isTyping}
                  className="absolute right-2 w-10 h-10 bg-indigo-600 text-white rounded-full flex items-center justify-center disabled:opacity-30 disabled:grayscale transition-all hover:scale-105 active:scale-95"
                >➔</button>
              </form>
            </footer>
          </div>
        ) : (
          <button 
            onClick={() => setIsRakshakOpen(true)}
            className="pointer-events-auto group relative w-16 h-16 bg-gradient-to-tr from-indigo-600 to-fuchsia-600 rounded-full shadow-2xl flex items-center justify-center text-2xl border-4 border-white active:scale-90 transition-transform"
          >
            <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-20"></div>
            🛡️
            <div className="absolute -top-12 right-0 bg-white text-indigo-700 px-4 py-1.5 rounded-xl shadow-lg text-[10px] font-black animate-bounce whitespace-nowrap">
              Bhai se msg karo! ✨
            </div>
          </button>
        )}
      </div>

      <style>{`
        @keyframes pulse { 0% { box-shadow: 0 0 10px #c62828; } 50% { box-shadow: 0 0 30px #c62828; } 100% { box-shadow: 0 0 10px #c62828; } }
        @keyframes strobe { 0% { background: rgba(255,0,0,0.4); } 50% { background: rgba(0,0,255,0.4); } 100% { background: rgba(255,0,0,0.4); } }
        .animate-widget { animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      `}</style>
    </div>
  );
};

export default App;
