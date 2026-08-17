'use strict'

const shell = window.splitSquareShell
const menuButtons = [...document.querySelectorAll('[data-menu]')]
const backButton = document.querySelector('[data-command="back"]')
const forwardButton = document.querySelector('[data-command="forward"]')

for (const button of menuButtons) {
  button.addEventListener('click', () => {
    const menu = button.dataset.menu
    const bounds = button.getBoundingClientRect()
    button.setAttribute('aria-expanded', 'true')
    shell.command({
      type: 'menu',
      menu,
      x: Math.max(0, Math.round(bounds.left)),
      y: Math.max(0, Math.round(bounds.bottom)),
    })
    window.setTimeout(() => button.setAttribute('aria-expanded', 'false'), 0)
  })
}

for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('click', () => shell.command({ type: button.dataset.command }))
}

shell.onState((state) => {
  backButton.disabled = !state.canGoBack
  forwardButton.disabled = !state.canGoForward
})
