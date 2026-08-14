class VUMeter {
    constructor(width, height, options = {}) {
        this.width = width;
        this.height = height;
        this.orientation = options.orientation || 'vertical'; // 'vertical' o 'horizontal'
        this.currentDb = -60;
        this.targetDb = -60;
        this.peakDb = -60;
        this.peakHoldTime = 0;
        this.clipDetected = false;
        this.isSelected = false;
        this.minDb = options.minDb || -60;
        this.maxDb = options.maxDb || 6;
        this.clipThreshold = options.clipThreshold || 0;
        this.peakHoldDuration = options.peakHoldDuration || 2000; // ms
        this.smoothingFactor = options.smoothingFactor || 0.3;
        this.onClick = options.onClick || undefined;

        // db marker
        this.dbMarkers = [0, -6, -12, -20, -40];

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'mod-vumeter'
        this.canvas.width = width;
        this.canvas.height = height;
        this.canvas.style.width = width;
        this.canvas.style.height = height;
        this.canvas.style.display = 'block';
        this.ctx = this.canvas.getContext('2d');

        this.wrapper = document.createElement('div');
        this.wrapper.className = `mod-vumeter-wrapper orientation-${this.orientation}`;
        this.wrapper.style.position = 'relative'; // Utile per posizionare il clip indicator

        this.clipIndicator = document.createElement('div');
        this.clipIndicator.className = 'mod-vumeter-clip-indicator';
        this.clipIndicator.textContent = 'CLIP';

        this.wrapper.appendChild(this.canvas);
        this.wrapper.appendChild(this.clipIndicator);

        this.canvas.addEventListener('dblclick', (e) => {
            this.resetClip();
            e.stopPropagation();
        });
        this.canvas.addEventListener('click', (e) => {
            if (this.onClick) {
                this.onClick(this, e)
            }
        });

        this.animate();
    }

    getElement() {
        return this.wrapper;
    }

    getLabel() {
        return this.clipIndicator.textContent;
    }

    setLabel(label) {
        this.clipIndicator.textContent = label;
    }

    getLabelIsVisible() {
        return this.clipIndicator.style.display != 'none';
    }

    setLabelIsVisible(visibility) {
        this.clipIndicator.style.display = visibility ? 'unset' : 'none';
    }

    getIsSelected() {
        return this.isSelected;
    }

    setIsSelected(selected) {
        this.isSelected = selected;
    }

    getLevel() {
        return this.targetDb;
    }

    setLevel(db) {
        this.targetDb = Math.max(this.minDb, Math.min(this.maxDb, db));

        if (db >= this.clipThreshold) {
            this.clipDetected = true;
            this.clipIndicator.classList.add('active');
        }

        if (db > this.peakDb) {
            this.peakDb = db;
            this.peakHoldTime = Date.now();
        }
    }

    getClip() {
        return this.clipDetected;
    }

    setClip() {
        this.clipDetected = true;
    }

    resetClip() {
        this.clipDetected = false;
        this.clipIndicator.classList.remove('active');
        this.peakDb = this.currentDb;
    }

    // Restituisce la dimensione in pixel corrispondente al valore in dB
    dbToPixels(db, totalLength) {
        const borderWidth = 1;
        const availableLength = totalLength - (borderWidth * 2);
        const normalized = (db - this.minDb) / (this.maxDb - this.minDb);
        return normalized * availableLength;
    }

    drawRoundedRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    draw() {
        const w = this.canvas.offsetWidth;
        const h = this.canvas.offsetHeight;
        
        if (isNaN(w) || isNaN(h) || w < 1 || h < 1) {
            return;
        }

        this.canvas.height = h;
        this.canvas.width = w;
        const ctx = this.ctx;
        const borderWidth = 1;

        const isVert = this.orientation === 'vertical';
        const totalLength = isVert ? h : w;

        // Clear & Background
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, w, h);

        const barSize = this.dbToPixels(this.currentDb, totalLength);
        const zeroDbSize = this.dbToPixels(0, totalLength);
        const barTouchesZeroDb = barSize >= zeroDbSize - 1;

        if (barSize > 0) {
            const availableLength = totalLength - (borderWidth * 2);
            let gradient;

            // Il gradiente deve andare da sinistra a destra (orizzontale) o dal basso verso l'alto (verticale)
            if (isVert) {
                gradient = ctx.createLinearGradient(0, h - borderWidth, 0, borderWidth);
            } else {
                gradient = ctx.createLinearGradient(borderWidth, 0, w - borderWidth, 0);
            }

            const greenSize = this.dbToPixels(-12, totalLength);
            const yellowSize = this.dbToPixels(-3, totalLength);
            const redSize = this.dbToPixels(0, totalLength);

            gradient.addColorStop(0, '#00ff00');
            gradient.addColorStop(Math.min(1, greenSize / availableLength), '#00ff00');
            gradient.addColorStop(Math.min(1, yellowSize / availableLength), '#ffff00');
            gradient.addColorStop(Math.min(1, redSize / availableLength), '#ff3300');
            gradient.addColorStop(1, '#ff0000');

            ctx.fillStyle = gradient;

            if (isVert) {
                ctx.fillRect(borderWidth, h - borderWidth - barSize, w - (borderWidth * 2), barSize);
            } else {
                ctx.fillRect(borderWidth, borderWidth, barSize, h - (borderWidth * 2));
            }
        }

        // Controllo larghezza/altezza minima per disegnare la scala dei dB
        const canDrawScale = isVert ? (w >= 22) : (h >= 22);

        if (canDrawScale) {
            ctx.font = '12px monospace';
            
            if (isVert) {
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
            } else {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
            }

            const labelPadding = 2;
            const labelBgWidth = 18;
            const labelBgHeight = 12;
            const labelBgRadius = 2;

            this.dbMarkers.forEach(db => {
                const markerSize = this.dbToPixels(db, totalLength);
                const isAboveBar = markerSize > barSize;
                const isZeroDb = db === 0;
                const zeroDbColor = barTouchesZeroDb ? '#ffffff' : '#ff0000';

                ctx.strokeStyle = isZeroDb ? zeroDbColor : '#444';
                ctx.lineWidth = isZeroDb ? 1.5 : 1;

                let textX, textY;

                ctx.beginPath();
                if (isVert) {
                    const y = h - borderWidth - markerSize;
                    ctx.moveTo(borderWidth, y);
                    ctx.lineTo(borderWidth + (w * 0.15), y);
                    textX = w - borderWidth - labelPadding;
                    textY = y;
                } else {
                    const x = borderWidth + markerSize;
                    ctx.moveTo(x, h - borderWidth);
                    ctx.lineTo(x, h - borderWidth - (h * 0.15));
                    textX = x;
                    textY = h - borderWidth - labelPadding;
                }
                ctx.stroke();

                const text = db.toString();

                // Disegna sfondo scuro sotto il testo se la barra ci passa sopra
                if (!isAboveBar) {
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
                    if (isVert) {
                        this.drawRoundedRect(ctx, w - borderWidth - labelBgWidth, textY - labelBgHeight / 2, labelBgWidth, labelBgHeight, labelBgRadius);
                    } else {
                        this.drawRoundedRect(ctx, textX - labelBgWidth / 2, textY - labelBgHeight, labelBgWidth, labelBgHeight, labelBgRadius);
                    }
                    ctx.fill();
                }

                // Disegna il testo del marcatore
                if (isZeroDb) {
                    ctx.strokeStyle = '#000';
                    ctx.lineWidth = 2.5;
                    ctx.strokeText(text, textX, textY);
                    ctx.fillStyle = zeroDbColor;
                    ctx.fillText(text, textX, textY);
                } else {
                    ctx.fillStyle = isAboveBar ? '#666' : '#ccc';
                    ctx.fillText(text, textX, textY);
                }
            });
        }

        // Linea tratteggiata dello 0dB
        const zeroDbPos = zeroDbSize;
        const zeroDbLineColor = barTouchesZeroDb ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 0, 0, 0.3)';
        ctx.strokeStyle = zeroDbLineColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        if (isVert) {
            const zeroDbY = h - borderWidth - zeroDbPos;
            ctx.moveTo(borderWidth, zeroDbY);
            ctx.lineTo(w - borderWidth, zeroDbY);
        } else {
            const zeroDbX = borderWidth + zeroDbPos;
            ctx.moveTo(zeroDbX, borderWidth);
            ctx.lineTo(zeroDbX, h - borderWidth);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Peak hold indicator
        const now = Date.now();
        if (now - this.peakHoldTime < this.peakHoldDuration) {
            const peakSize = this.dbToPixels(this.peakDb, totalLength);
            const isClipping = this.peakDb >= this.clipThreshold;
            
            ctx.fillStyle = isClipping ? '#ff0000' : '#ffffff';

            if (isClipping) {
                ctx.shadowColor = '#ff0000';
                ctx.shadowBlur = 4;
            }

            if (isVert) {
                const peakY = h - borderWidth - peakSize;
                ctx.fillRect(borderWidth, peakY - 1, w - (borderWidth * 2), 2);
            } else {
                const peakX = borderWidth + peakSize;
                ctx.fillRect(peakX - 1, borderWidth, 2, h - (borderWidth * 2));
            }

            ctx.shadowBlur = 0;
        } else {
            this.peakDb = Math.max(this.currentDb, this.peakDb - 0.5);
        }

        // Border condizionale (Clip / Selection / Default)
        ctx.lineWidth = 1;
        if (this.clipDetected) {
            ctx.strokeStyle = '#ff0000';
        } else if (this.isSelected) {
            ctx.strokeStyle = '#883996';
            ctx.lineWidth = 2;
        } else {
            ctx.strokeStyle = '#333';
        }
        ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    }

    animate() {
        this.currentDb += (this.targetDb - this.currentDb) * this.smoothingFactor;
        this.draw();
        requestAnimationFrame(() => this.animate());
    }
}