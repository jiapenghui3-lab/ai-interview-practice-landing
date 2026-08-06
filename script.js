const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const mobileStory = matchMedia('(max-width: 820px)');

const revealItems = [...document.querySelectorAll('[data-reveal]')];
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    entry.target.classList.toggle('in-view', entry.isIntersecting);
  });
}, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' });

revealItems.forEach((item) => revealObserver.observe(item));

const typewriter = document.querySelector('#typewriter');
const typeLink = document.querySelector('#type-link');
const heroCount = document.querySelector('#hero-count');
const phrases = [
  { text: '正式上场才第一次慌', target: '#complete' },
  { text: '练的题和岗位没关系', target: '#matched' },
  { text: '一被追问就说不清', target: '#followup' },
  { text: '答完也不知道哪里错', target: '#report' }
];

let phraseIndex = 0;
let characterIndex = 0;
let deleting = false;

function typeStep() {
  if (!typewriter || !typeLink) return;
  const phrase = phrases[phraseIndex];
  typeLink.href = phrase.target;
  characterIndex += deleting ? -1 : 1;
  typewriter.textContent = phrase.text.slice(0, characterIndex);

  let delay = deleting ? 52 : 92;
  if (!deleting && characterIndex === phrase.text.length) {
    deleting = true;
    delay = 1650;
  } else if (deleting && characterIndex === 1) {
    deleting = false;
    phraseIndex = (phraseIndex + 1) % phrases.length;
    characterIndex = 1;
    typewriter.textContent = phrases[phraseIndex].text.slice(0, characterIndex);
    typeLink.href = phrases[phraseIndex].target;
    delay = 240;
  }
  setTimeout(typeStep, delay);
}

if (typewriter && typeLink) {
  if (reduceMotion.matches) {
    typewriter.textContent = phrases[0].text;
    typeLink.href = phrases[0].target;
  } else {
    typeStep();
  }
}

const countValues = ['1', '2', '3', '4', '5'];
let countIndex = 0;

function countTypeStep() {
  if (!heroCount || reduceMotion.matches) return;
  heroCount.classList.add('is-deleting');
  setTimeout(() => {
    countIndex = (countIndex + 1) % countValues.length;
    heroCount.textContent = countValues[countIndex];
    heroCount.classList.remove('is-deleting');
    setTimeout(countTypeStep, 1050);
  }, 170);
}

if (heroCount && !reduceMotion.matches) {
  setTimeout(countTypeStep, 1200);
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function easeOut(value) {
  return 1 - Math.pow(1 - value, 3);
}

function smoothStep(value) {
  return value * value * (3 - 2 * value);
}

const journey = document.querySelector('[data-journey]');
const journeySteps = journey ? [...journey.querySelectorAll('[data-journey-step]')] : [];
const journeyDots = journey ? [...journey.querySelectorAll('.journey-dots li')] : [];
const journeyCount = journey?.querySelector('[data-journey-count]');
const navLinks = [...document.querySelectorAll('.site-header nav a')];
const journeySlot = () => innerHeight * .92;
let journeyTarget = 0;
let journeyRendered = 0;
let journeyFrame = 0;
let activeJourneyIndex = 0;

const mobileJourneyObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    entry.target.classList.toggle('mobile-in-view', entry.isIntersecting);
  });
}, { threshold: .18, rootMargin: '0px 0px -8% 0px' });
journeySteps.forEach((step) => mobileJourneyObserver.observe(step));

function clearJourneyStyles() {
  journeySteps.forEach((step, index) => {
    step.removeAttribute('style');
    step.querySelector('.journey-copy')?.removeAttribute('style');
    step.querySelector('.journey-screen')?.removeAttribute('style');
    step.querySelector('.journey-guide')?.removeAttribute('style');
    step.classList.toggle('is-active', index === 0);
    step.classList.remove('is-near');
  });
  journeyDots.forEach((dot, index) => dot.classList.toggle('is-active', index === 0));
  if (journeyCount) journeyCount.textContent = `01 / ${String(journeySteps.length).padStart(2, '0')}`;
}

function updateNav(index) {
  if (!journey) return;
  const beforeJourney = scrollY < journey.offsetTop - innerHeight * .45;
  navLinks.forEach((link) => {
    const href = link.getAttribute('href');
    let active = false;
    if (!beforeJourney) {
      if (href === '#complete') active = index <= 3;
      if (href === '#followup') active = index >= 4 && index <= 7;
      if (href === '#report') active = index >= 8;
    }
    link.classList.toggle('is-active', active);
  });
}

function renderJourney(raw) {
  if (!journey || !journeySteps.length) return;
  const last = journeySteps.length - 1;
  activeJourneyIndex = clamp(Math.floor(raw + .32), 0, last);
  journeyDots.forEach((dot, index) => dot.classList.toggle('is-active', index === activeJourneyIndex));
  if (journeyCount) journeyCount.textContent = `${String(activeJourneyIndex + 1).padStart(2, '0')} / ${String(journeySteps.length).padStart(2, '0')}`;
  updateNav(activeJourneyIndex);

  journeySteps.forEach((step, index) => {
    const copy = step.querySelector('.journey-copy');
    const screen = step.querySelector('.journey-screen');
    const guide = step.querySelector('.journey-guide');
    const side = step.dataset.side === 'right' ? 1 : -1;
    const screenSide = -side;
    const enterRaw = index === 0
      ? 1
      : clamp((raw - (index - .32)) / .32);
    const exitRaw = index === last ? 0 : clamp((raw - (index + .68)) / .32);
    const enter = easeOut(enterRaw);
    const exit = smoothStep(exitRaw);
    const visibility = clamp(enter * (1 - exit));
    const hidden = 1 - enter;

    step.style.zIndex = String(10 + index);
    step.style.opacity = String(visibility);
    step.style.pointerEvents = visibility > .96 ? 'auto' : 'none';
    step.style.filter = `blur(${Math.max(0, hidden * 2 + exit * 2)}px)`;
    step.classList.toggle('is-active', index === activeJourneyIndex);
    step.classList.toggle('is-near', Math.abs(index - activeJourneyIndex) <= 1);

    if (copy) {
      const x = side * (34 * hidden + 48 * exit);
      const y = 24 * hidden - innerHeight * .04 * exit;
      const scale = .985 + .015 * enter - .02 * exit;
      copy.style.opacity = String(visibility);
      copy.style.filter = `blur(${6 * hidden + 6 * exit}px)`;
      copy.style.transform = `translate3d(${x}px, calc(-50% + ${y}px), 0) scale(${scale})`;
    }

    if (screen) {
      const x = screenSide * (innerWidth * .07 * hidden + innerWidth * .05 * exit);
      const y = innerHeight * .07 * hidden - innerHeight * .055 * exit;
      const scale = .90 + .10 * enter - .08 * exit;
      const rotateZ = screenSide * (1.2 * hidden - .8 * exit);
      const baseY = step.dataset.side === 'right' ? 1.2 : -1.2;
      const rotateY = baseY - screenSide * 4 * hidden;
      screen.style.opacity = String(visibility);
      screen.style.filter = `blur(${10 * hidden + 7 * exit}px)`;
      screen.style.transform = `translate3d(${x}px, calc(-46% + ${y}px), 0) scale(${scale}) rotateZ(${rotateZ}deg) perspective(1400px) rotateY(${rotateY}deg)`;
    }

    if (guide) {
      const guideEnter = easeOut(clamp((enterRaw - .18) / .82));
      const guideVisibility = clamp(guideEnter * (1 - exit));
      const guideHidden = 1 - guideEnter;
      const bob = Math.sin(clamp(raw - index + .2, 0, 1) * Math.PI) * -8;
      guide.style.opacity = String(guideVisibility);
      guide.style.filter = `blur(${5 * guideHidden + 3 * exit}px)`;
      guide.style.transform = `translate3d(${side * (48 * guideHidden + 36 * exit)}px, ${18 * guideHidden - 24 * exit + bob}px, 0) rotate(${side * (8 * guideHidden - 2 * exit)}deg) scale(${.82 + .18 * guideEnter - .10 * exit})`;
    }
  });
}

function getJourneyTarget() {
  if (!journey || !journeySteps.length) return 0;
  return clamp((scrollY - journey.offsetTop) / journeySlot(), 0, journeySteps.length);
}

function animateJourney() {
  journeyFrame = 0;
  const difference = journeyTarget - journeyRendered;
  if (Math.abs(difference) > 1.5) journeyRendered += difference * .72;
  else journeyRendered += difference * .16;
  if (Math.abs(journeyTarget - journeyRendered) < .001) journeyRendered = journeyTarget;
  renderJourney(journeyRendered);
  if (journeyRendered !== journeyTarget) journeyFrame = requestAnimationFrame(animateJourney);
}

function scheduleJourney() {
  if (!journey) return;
  if (reduceMotion.matches || mobileStory.matches) {
    if (journeyFrame) cancelAnimationFrame(journeyFrame);
    journeyFrame = 0;
    clearJourneyStyles();
    return;
  }
  journeyTarget = getJourneyTarget();
  if (!journeyFrame) journeyFrame = requestAnimationFrame(animateJourney);
}

function updateProgress() {
  const max = document.documentElement.scrollHeight - innerHeight;
  const progress = max > 0 ? scrollY / max * 100 : 0;
  document.documentElement.style.setProperty('--progress', `${progress}%`);
}

let scrollFrame = 0;
function scheduleScrollEffects() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    updateProgress();
    scheduleJourney();
    scrollFrame = 0;
  });
}

addEventListener('scroll', scheduleScrollEffects, { passive: true });
addEventListener('resize', scheduleScrollEffects, { passive: true });
mobileStory.addEventListener?.('change', scheduleScrollEffects);
reduceMotion.addEventListener?.('change', scheduleScrollEffects);
scheduleScrollEffects();

const storyScenes = [...document.querySelectorAll('[data-scene]')];
const storyObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    entry.target.classList.toggle('is-inview', entry.isIntersecting);
    if (!entry.isIntersecting) return;

    const id = entry.target.id;
    navLinks.forEach((link) => {
      const href = link.getAttribute('href');
      const active = href === `#${id}`
        || (href === '#complete' && (id === 'complete' || id === 'matched'));
      link.classList.toggle('is-active', active);
    });
  });
}, { threshold: .28, rootMargin: '-12% 0px -35%' });

storyScenes.forEach((scene) => storyObserver.observe(scene));

const heroPupils = [...document.querySelectorAll('.hero-pupil')];
const pagePupils = [...document.querySelectorAll('.ip-pupil')];
const pointer = { x: innerWidth / 2, y: innerHeight / 2 };
let eyeFrame = 0;

function lookFrom(pupil, baseX, baseY, travel) {
  const dx = pointer.x - baseX;
  const dy = pointer.y - baseY;
  const distance = Math.hypot(dx, dy) || 1;
  pupil.style.setProperty('--look-x', `${dx / distance * travel}px`);
  pupil.style.setProperty('--look-y', `${dy / distance * travel}px`);
}

function updateEyes() {
  eyeFrame = 0;
  heroPupils.forEach((pupil) => {
    const svg = pupil.ownerSVGElement;
    const rect = svg.getBoundingClientRect();
    const box = svg.viewBox.baseVal;
    const baseX = rect.left + (Number(pupil.getAttribute('cx')) - box.x) / box.width * rect.width;
    const baseY = rect.top + (Number(pupil.getAttribute('cy')) - box.y) / box.height * rect.height;
    const scale = rect.width / box.width;
    const travel = Math.max(3, Math.min(8, 8 * scale));
    lookFrom(pupil, baseX, baseY, travel);
  });

  [...new Set(pagePupils.map((pupil) => pupil.closest('.gaze-ip')))].forEach((host) => {
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const dx = pointer.x - (rect.left + rect.width / 2);
    const dy = pointer.y - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy) || 1;
    const travel = Math.max(2, Math.min(4.5, rect.width * .03));
    host.querySelectorAll('.ip-pupil').forEach((pupil) => {
      pupil.style.setProperty('--look-x', `${dx / distance * travel}px`);
      pupil.style.setProperty('--look-y', `${dy / distance * travel}px`);
    });
  });
}

function scheduleEyes() {
  if (!eyeFrame) eyeFrame = requestAnimationFrame(updateEyes);
}

addEventListener('pointermove', (event) => {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  scheduleEyes();
}, { passive:true });
addEventListener('resize', scheduleEyes, { passive:true });
addEventListener('scroll', scheduleEyes, { passive:true });
scheduleEyes();
