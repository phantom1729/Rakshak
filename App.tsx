
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

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

// Helper functions for base64 encoding/decoding
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
  const [isLive, setIsLive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [callStatus, setCallStatus] = useState<'idle' | 'connecting' | 'active'>('idle');

  const liveSessionRef = useRef<any>(null);
  const audioCtxRef = useRef<{ input: AudioContext, output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSources = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Notify parent window of state changes
  useEffect(() => {
    window.parent.postMessage({ type: 'rakshak-state', isOpen }, '*');
    if (!isOpen) {
        stopVoice();
    }
  }, [isOpen]);

  const startVoice = async () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        alert("API Key missing!");
        return;
    }
    setCallStatus('connecting');
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
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) int16[i] = inputData[i] * 32768;
              const pcmData = new Uint8Array(int16.buffer);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: { data: encode(pcmData), mimeType: 'audio/pcm;rate=16000' } });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
            setIsLive(true);
            setCallStatus('active');
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
          onclose: () => {
              setIsLive(false);
              setCallStatus('idle');
          },
          onerror: (e) => { 
              console.error("Live Error:", e); 
              setIsLive(false); 
              setCallStatus('idle');
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          systemInstruction: RAKSHAK_PROMPT
        }
      });
      liveSessionRef.current = await sessionPromise;
    } catch (e) { 
      console.error("Mic error:", e);
      alert("Mic permission check kar behen!"); 
      setCallStatus('idle');
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
    setCallStatus('idle');
  };

  return (
    <div className="fixed inset-0 pointer-events-none flex items-end justify-end p-4 z-50 overflow-hidden">
      {isOpen ? (
        <div className="pointer-events-auto w-full max-w-[420px] h-[80vh] flex flex-col glass rounded-[2.5rem] shadow-2xl border border-white/50 animate-widget overflow-hidden">
          <header className="bg-gradient-to-r from-indigo-700 to-fuchsia-700 p-6 flex items-center justify-between text-white shadow-lg">
            <div className="flex items-center gap-4">
              <div className="relative">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center font-bold backdrop-blur-sm border border-white/20">RB</div>
                <div className={`absolute -bottom-1 -right-1 w-3 h-3 border-2 border-indigo-700 rounded-full ${callStatus === 'active' ? 'bg-green-400' : 'bg-slate-400'}`}></div>
              </div>
              <div>
                <h2 className="font-bold leading-none text-lg">Rakshak Bhai</h2>
                <span className="text-[10px] opacity-80 font-black uppercase tracking-widest">
                    {callStatus === 'active' ? 'Call Active' : callStatus === 'connecting' ? 'Connecting...' : 'Online'}
                </span>
              </div>
            </div>
            <button onClick={() => setIsOpen(false)} className="w-10 h-10 rounded-full bg-black/10 hover:bg-black/20 flex items-center justify-center transition-colors">✕</button>
          </header>
          
          <main className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-50/50 space-y-12 relative overflow-hidden">
            {/* Call UI */}
            <div className="relative flex flex-col items-center gap-6">
                <div className="relative">
                    <div className={`w-48 h-48 rounded-full flex flex-col items-center justify-center transition-all duration-700 shadow-2xl z-10 relative border-4 border-white ${isSpeaking ? 'bg-indigo-600 scale-105' : 'bg-white'}`}>
                        <span className="text-6xl mb-2">{isSpeaking ? '🗣️' : (callStatus === 'active' ? '👂' : '🛡️')}</span>
                        <div className={`flex flex-col items-center ${isSpeaking ? 'text-white' : 'text-indigo-600'}`}>
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] animate-pulse">
                                {callStatus === 'active' ? (isSpeaking ? 'Bhai Bol Raha Hai' : 'Sun Raha Hoon...') : 'Bhai Yahi Hai'}
                            </span>
                        </div>
                    </div>
                    {callStatus === 'active' && (
                        <>
                            <div className="absolute inset-0 bg-indigo-500/20 rounded-full animate-ping -z-10 scale-150"></div>
                            <div className="absolute inset-0 bg-indigo-500/10 rounded-full animate-ping -z-10 scale-[2] delay-300"></div>
                        </>
                    )}
                </div>

                <div className="text-center space-y-2">
                    <h3 className="text-2xl font-black text-slate-800 tracking-tight">
                        {callStatus === 'active' ? "Rakshak Call" : "Bhai se baat karo"}
                    </h3>
                    <p className="text-sm text-slate-500 max-w-[240px] font-medium leading-relaxed">
                        {callStatus === 'active' 
                            ? "Jo bhi mann mein hai, khul ke bolo. Tera bhai sun raha hai." 
                            : "Click karo aur call shuru karo. Tension mat le behen."}
                    </p>
                </div>
            </div>

            {/* Action Button */}
            <div className="flex flex-col items-center gap-4 w-full px-6">
                {callStatus === 'idle' ? (
                    <button 
                        onClick={startVoice}
                        className="w-full py-5 bg-gradient-to-r from-indigo-600 to-fuchsia-700 text-white rounded-[1.5rem] font-black text-lg shadow-xl hover:shadow-indigo-500/30 hover:-translate-y-1 active:translate-y-0 transition-all flex items-center justify-center gap-3 group"
                    >
                        <span className="text-2xl group-hover:animate-bounce">📞</span> Call Bhai
                    </button>
                ) : (
                    <button 
                        onClick={stopVoice}
                        className="w-full py-5 bg-red-500 text-white rounded-[1.5rem] font-black text-lg shadow-xl hover:bg-red-600 active:scale-95 transition-all flex items-center justify-center gap-3"
                    >
                        <span className="text-2xl">🛑</span> Call Khatam
                    </button>
                )}
                
                {callStatus === 'connecting' && (
                    <div className="flex items-center gap-2 text-indigo-600 font-bold animate-pulse italic">
                        <div className="w-2 h-2 bg-indigo-600 rounded-full animate-bounce"></div>
                        <div className="w-2 h-2 bg-indigo-600 rounded-full animate-bounce delay-75"></div>
                        <div className="w-2 h-2 bg-indigo-600 rounded-full animate-bounce delay-150"></div>
                        <span>Connecting...</span>
                    </div>
                )}
            </div>

            {/* Decorative element */}
            <div className="absolute bottom-[-50px] left-[-50px] w-48 h-48 bg-indigo-200/20 rounded-full blur-3xl -z-10"></div>
            <div className="absolute top-[20%] right-[-30px] w-32 h-32 bg-fuchsia-200/20 rounded-full blur-2xl -z-10"></div>
          </main>
          
          <footer className="p-6 bg-white/50 backdrop-blur-sm border-t border-white flex justify-center">
             <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">End-to-End Safe & Supportive</p>
          </footer>
        </div>
      ) : (
        <button onClick={() => setIsOpen(true)} className="pointer-events-auto group relative">
          <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-20"></div>
          <div className="w-16 h-16 bg-gradient-to-br from-indigo-600 to-fuchsia-700 rounded-full shadow-2xl flex items-center justify-center text-3xl border-4 border-white z-10 transform transition-transform group-hover:scale-110 active:scale-90 relative overflow-hidden">
              <span className="relative z-10">📞</span>
              <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"></div>
          </div>
          <div className="absolute -top-12 right-0 bg-white px-4 py-2 rounded-xl shadow-xl text-[11px] font-bold text-indigo-700 whitespace-nowrap animate-bounce border border-indigo-50">Bhai ko call karo! ✨</div>
        </button>
      )}
    </div>
  );
};

export default App;
