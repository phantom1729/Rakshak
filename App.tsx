import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';

const RAKSHAK_PROMPT = `
Tera naam "Rakshak" hai. Tum ek "Big Brother" (Bhai) aur "Best Friend" ka combination ho.
Kaam: Tum un ladkiyon ki help karte ho jo life ke mushkil waqt se guzar rahi hain ya jinhe koi sunne wala chahiye.
Personality: 
- Boht patience rakho. Agar wo ro rahi hai ya chup hai, toh bas saath raho, jaldi mat karo.
- Voice conversation mein "Puck" voice use karo.
- Kabhi judge mat karo. Hamesha support karo.
- Hinglish use karo (Jaise: "Oye pagal", "Tension mat le", "Bhai khada hai na yahan").
- Baat karne ka tarika aisa ho jaise ek sacha bada bhai apni choti behen ko samjhata hai.
`;

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

  // SEND MESSAGE TO HOST WEBSITE
  useEffect(() => {
    window.parent.postMessage({ type: 'rakshak-state', isOpen }, '*');
  }, [isOpen]);

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
      setMessages(prev => [...prev, { id: 'err', role: 'model', text: "Bhai thoda busy ho gaya lagta hai..." }]);
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
          onopen: () => setIsLive(true),
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
          },
          onclose: () => setIsLive(false)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          systemInstruction: RAKSHAK_PROMPT
        }
      });
      liveSessionRef.current = await sessionPromise;
      // In a real implementation, you'd add the ScriptProcessor logic here as well.
    } catch (e) { alert("Mic check kar behen!"); }
  };

  const stopVoice = () => {
    if (liveSessionRef.current) liveSessionRef.current.close();
    setIsLive(false);
    setIsSpeaking(false);
  };

  return (
    <div className="fixed inset-0 pointer-events-none flex items-end justify-end p-4 z-50 overflow-hidden">
      {isOpen ? (
        <div className="pointer-events-auto w-full max-w-[420px] h-[90vh] flex flex-col glass rounded-[2.5rem] shadow-2xl border border-white/50 animate-widget overflow-hidden">
          <header className="bg-gradient-to-r from-indigo-700 to-fuchsia-700 p-6 flex items-center justify-between text-white">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center font-bold">RB</div>
              <h2 className="font-bold">Rakshak Bhai</h2>
            </div>
            <button onClick={() => setIsOpen(false)} className="w-8 h-8 rounded-full bg-black/10">✕</button>
          </header>
          <main className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/50 no-scrollbar" ref={scrollRef}>
            {messages.map(m => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`px-4 py-3 rounded-2xl text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-indigo-50'}`}>{m.text}</div>
              </div>
            ))}
          </main>
          <footer className="p-4 bg-white flex gap-2">
            <button onClick={startVoice} className="w-12 h-12 bg-indigo-50 rounded-xl">🎤</button>
            <form onSubmit={sendMessage} className="flex-1 flex gap-2">
              <input value={inputValue} onChange={e => setInputValue(e.target.value)} className="flex-1 bg-slate-100 rounded-xl px-4 text-sm" placeholder="Bol na..." />
              <button type="submit" className="w-12 h-12 bg-indigo-600 text-white rounded-xl">🚀</button>
            </form>
          </footer>
        </div>
      ) : (
        <button onClick={() => setIsOpen(true)} className="pointer-events-auto group relative">
          <div className="absolute inset-0 bg-indigo-600 rounded-full animate-ping opacity-20"></div>
          <div className="w-16 h-16 bg-gradient-to-br from-indigo-600 to-fuchsia-700 rounded-full shadow-xl flex items-center justify-center text-3xl border-4 border-white z-10">❤️</div>
          <div className="absolute -top-12 right-0 bg-white px-4 py-2 rounded-xl shadow-lg text-[11px] font-bold text-indigo-700 whitespace-nowrap animate-bounce">Bhai hai na! ✨</div>
        </button>
      )}
    </div>
  );
};

export default App;