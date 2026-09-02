import { motion, useReducedMotion } from 'motion/react'

const VIDEO_URL =
  'https://res.cloudinary.com/daklr2whx/video/upload/v1778602552/track-video_2_s9lp53.mp4'

const reveal = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0 },
}

function BrandMark() {
  return (
    <svg
      aria-label="S.P.D brand mark"
      className="mb-12"
      width="80"
      height="80"
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M60 120C26.8629 120 0 93.1371 0 60V0C22.5654 0 42.2213 12.4569 52.4662 30.8691C38.4788 34.2089 28.0787 46.7902 28.0787 61.8006V63.1443C28.0787 79.9648 41.7146 93.6006 58.5353 93.6006H59.8789L59.8785 61.8006C59.8785 79.3633 74.1159 93.6006 91.6787 93.6006L91.6787 61.8006C91.6787 44.2783 77.5071 30.0661 60 30.0008L60 0H62.5352C94.2722 0 120 25.7279 120 57.4648V60C120 93.1371 93.1371 120 60 120Z"
        fill="white"
      />
    </svg>
  )
}

export default function App() {
  const prefersReducedMotion = useReducedMotion()
  const initial = prefersReducedMotion ? 'visible' : 'hidden'

  return (
    <main>
      <section className="relative z-10 flex min-h-screen w-full flex-col bg-[#FF0000]">
        <div className="flex w-full flex-1 flex-col items-center pt-[100px] md:pt-[400px]">
          <motion.div
            initial={initial}
            animate="visible"
            transition={{ staggerChildren: 0.12, delayChildren: 0.1 }}
            className="relative z-20 mx-auto flex h-auto w-full max-w-[900px] flex-col items-center px-8 text-center md:h-[620px]"
          >
            <motion.div variants={reveal} transition={{ duration: 0.65, ease: 'easeOut' }}>
              <BrandMark />
            </motion.div>

            <motion.p
              variants={reveal}
              transition={{ duration: 0.65, ease: 'easeOut' }}
              className="mx-auto mb-[40px] h-[100px] w-full max-w-[400px] text-[16px] leading-[1.6] tracking-wider text-white uppercase"
            >
              We built this platform with a single purpose to eliminate operational chaos and
              restore balance to your daily business routine
            </motion.p>

            <motion.div
              variants={reveal}
              transition={{ duration: 0.65, ease: 'easeOut' }}
              className="font-marck mb-[32px] text-[120px] leading-none text-white"
            >
              S.P.D
            </motion.div>

            <motion.div
              variants={reveal}
              transition={{ duration: 0.65, ease: 'easeOut' }}
              className="mb-[100px] flex w-full flex-col items-center font-light leading-[1.6] text-white md:mb-24"
            >
              <p className="mb-[24px] w-[400px] max-w-full text-center text-[16px]">
                I Was Exhausted By Software That Demanded More Effort Than It Actually Saved. That
                Is Why We Engineered An Autonomous Architecture That Operates Silently In The
                Background.
              </p>
              <p className="w-[400px] max-w-full text-center text-[16px]">
                Your Business Should Serve Your Life, Not Consume It. Let Our Algorithms Handle The
                Heavy Lifting, So You Can Focus On The Vision.
              </p>
            </motion.div>
          </motion.div>
        </div>

        <div className="relative w-full shrink-0">
          <div className="pointer-events-none absolute top-0 left-0 z-10 h-[100px] w-full bg-gradient-to-b from-[#FF0000] to-transparent" />
          <video
            autoPlay
            loop
            muted
            playsInline
            aria-label="Abstract S.P.D brand film"
            className="block h-auto w-full object-contain"
          >
            <source src={VIDEO_URL} type="video/mp4" />
          </video>
        </div>
      </section>
    </main>
  )
}
